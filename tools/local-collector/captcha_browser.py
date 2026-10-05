"""Bounded, local CAPTCHA adapters using observed DOM controls and local models."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlsplit
import mycdp as cdp
import mycdp.input_
import mycdp.page
import mycdp.runtime

HERE = Path(__file__).resolve().parent
GRID_SCRIPT = r'''
const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
const target=document.querySelector('.rc-imageselect-target');
const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
if(!target||!visible(target))return null;
const cells=[...target.querySelectorAll('td')];
if(![9,16].includes(cells.length)||cells.some(e=>!e.querySelector('img')?.complete||!e.querySelector('img')?.naturalWidth))return null;
const prompt=document.querySelector('.rc-imageselect-desc-wrapper')?.innerText||'';
const button=selector=>{const e=document.querySelector(selector);return e&&visible(e)&&!e.disabled?rect(e):null;};
return {prompt,rect:rect(target),cells:cells.map(e=>({...rect(e),selected:e.classList.contains('rc-imageselect-tileselected')})),
 sources:cells.map(e=>e.querySelector('img')?.currentSrc||''),
 dynamic:/new images|none left|once there are none|没有新|沒有新|新图片|新圖片/.test(prompt.toLowerCase()),
 verify:button('#recaptcha-verify-button'),reload:button('#recaptcha-reload-button')};
'''
LOCAL_WIDGET_SCRIPT = r'''
const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
const one=s=>[...document.querySelectorAll(s)].filter(visible);
const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
const png=e=>{if(e.tagName==='CANVAS')return e.toDataURL('image/png');if(!e.complete||!e.naturalWidth)return null;const c=document.createElement('canvas');c.width=e.naturalWidth;c.height=e.naturalHeight;c.getContext('2d').drawImage(e,0,0);return c.toDataURL('image/png');};
const inputs=one('input[name="captcha"],input[name="captcha_code"],input[autocomplete="captcha"]');
if(inputs.length===1){const input=inputs[0],form=input.closest('form'),images=[...(form||document).querySelectorAll('img[src*="captcha"],img[id*="captcha"]')].filter(visible);
 const buttons=form?[...form.querySelectorAll('button[type="submit"],input[type="submit"]')].filter(visible):[];
 const others=form?[...form.querySelectorAll('input,textarea,select')].filter(e=>e!==input&&visible(e)&&!['submit','button','hidden'].includes(e.type)):[];
 if(images.length===1&&buttons.length===1&&!others.length&&!form.querySelector('input[type="password"]')&&!buttons[0].disabled)return {kind:'text',image:rect(images[0]),input:rect(input),submit:rect(buttons[0]),signature:images[0].src};}
for(const [background,piece,handle] of [['.geetest_canvas_bg','.geetest_canvas_slice','.geetest_slider_button'],['.yidun_bg-img','.yidun_jigsaw','.yidun_slider']]){
 const bg=one(background),fg=one(piece),knob=one(handle);if(bg.length!==1||fg.length!==1||knob.length!==1)continue;
 try{return {kind:'slider',background:png(bg[0]),piece:png(fg[0]),rect:rect(bg[0]),handle:rect(knob[0]),piece_rect:rect(fg[0])};}catch{return {kind:'slider',unavailable:true};}}
return null;
'''


def signature(grid):
    return hashlib.sha256(json.dumps([grid.get('prompt'), grid.get('sources'), grid.get('rect')], sort_keys=True).encode()).hexdigest()


def infer(request, timeout):
    result = subprocess.run([sys.executable, '-X', 'utf8', str(HERE / 'captcha_vision.py')],
                            input=json.dumps(request), text=True, encoding='utf-8', capture_output=True,
                            timeout=max(0.1, timeout), creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode or len(result.stdout) > 100_000:
        return {'state': 'inference_failed'}
    return json.loads(result.stdout)


class CaptchaBrowser:
    def __init__(self, driver):
        self.driver = driver
        self.grid_history = {}

    @property
    def page(self):
        return self.driver.client.page

    async def evaluate(self, connection, script, context=None):
        obj, error = await connection.send(cdp.runtime.evaluate('(()=>{' + script + '})()',
            context_id=context, return_by_value=True, await_promise=True))
        if error:
            raise RuntimeError('CAPTCHA_DOM_FAILED')
        return obj.value if obj else None

    async def frame(self, kind='bframe'):
        frames = await self.evaluate(self.page, '''return [...document.querySelectorAll('iframe')].map(e=>{
          const r=e.getBoundingClientRect();return {url:e.src,x:r.x,y:r.y,w:r.width,h:r.height};}).filter(f=>f.w>0&&f.h>0);''')
        candidates = [f for f in frames or [] if urlsplit(f['url']).hostname in
                      ('www.google.com', 'www.recaptcha.net', 'recaptcha.google.com') and
                      urlsplit(f['url']).path.endswith('/' + kind)]
        if len(candidates) != 1:
            return None
        frame = candidates[0]
        browser = self.driver.client.driver
        await browser.update_targets()
        for target in browser.targets:
            if target.type_ == 'iframe' and target.target.url == frame['url']:
                # Chromium serves OOPIF targets under /devtools/page as well.
                # SeleniumBase 4.55's TargetCreated event uses /devtools/iframe,
                # which returns HTTP 404 and prevents access to the real puzzle.
                if target.closed:
                    target.websocket_url = f'ws://{browser.config.host}:{browser.config.port}/devtools/page/{target.target.target_id}'
                return target, None, frame
        tree = await self.page.send(cdp.page.get_frame_tree())
        def find(node):
            if node.frame.url == frame['url']:
                return node.frame.id_
            for child in node.child_frames or []:
                found = find(child)
                if found:
                    return found
        frame_id = find(tree)
        if frame_id:
            context = await self.page.send(cdp.page.create_isolated_world(frame_id, world_name='paper-captcha-dom'))
            return self.page, context, frame
        return None

    async def click(self, rect, offset=None):
        offset = offset or {'x': 0, 'y': 0}
        x, y = offset['x'] + rect['x'] + rect['w'] / 2, offset['y'] + rect['y'] + rect['h'] / 2
        await self.page.send(cdp.input_.dispatch_mouse_event('mousePressed', x=x, y=y,
            button=cdp.input_.MouseButton.LEFT, buttons=1, click_count=1))
        await self.page.send(cdp.input_.dispatch_mouse_event('mouseReleased', x=x, y=y,
            button=cdp.input_.MouseButton.LEFT, buttons=0, click_count=1))

    async def screenshot(self, rect, offset=None):
        offset = offset or {'x': 0, 'y': 0}
        if not 0 < rect['w'] <= 1200 or not 0 < rect['h'] <= 1200:
            raise ValueError('CAPTCHA_RECT_INVALID')
        return await self.page.send(cdp.page.capture_screenshot(format_='png',
            clip=cdp.page.Viewport(x=rect['x'] + offset['x'], y=rect['y'] + offset['y'],
                                   width=rect['w'], height=rect['h'], scale=1), capture_beyond_viewport=False))

    async def grid(self, timeout):
        started = time.monotonic()
        frame = await self.frame()
        if not frame:
            return {'state': 'challenge_frame_unavailable'}
        connection, context, offset = frame
        grid = await self.evaluate(connection, GRID_SCRIPT, context)
        if not grid:
            return {'state': 'challenge_loading'}
        from captcha_vision import prompt_class
        if prompt_class(grid['prompt']) is None:
            if grid.get('reload'):
                await self.click(grid['reload'], offset)
            return {'state': 'unsupported_prompt', 'refreshed': bool(grid.get('reload'))}
        png = await self.screenshot(grid['rect'], offset)
        cells = [{**c, 'x': c['x'] - grid['rect']['x'], 'y': c['y'] - grid['rect']['y']} for c in grid['cells']]
        result = await asyncio.to_thread(infer, {'kind': 'grid', 'prompt': grid['prompt'], 'image': png, 'cells': cells},
                                       min(20, max(0.1, timeout - (time.monotonic() - started) - 2)))
        if os.environ.get('PAPER_CAPTCHA_DEBUG_DIR'):
            import base64
            directory = Path(os.environ['PAPER_CAPTCHA_DEBUG_DIR'])
            directory.mkdir(parents=True, exist_ok=True)
            name = str(time.time_ns())
            (directory / (name + '.png')).write_bytes(base64.b64decode(png))
            (directory / (name + '.json')).write_text(json.dumps({'prompt': grid['prompt'], 'cells': cells, 'result': result}, ensure_ascii=False), encoding='utf-8')
        if result['state'] != 'recognized':
            return result
        current = await self.evaluate(connection, GRID_SCRIPT, context)
        if not current or signature(current) != signature(grid):
            return {'state': 'challenge_changed'}
        indices = [i for i in result['indices'] if 0 <= i < len(grid['cells']) and not grid['cells'][i]['selected']]
        for index in indices:
            await self.click(grid['cells'][index], offset)
            await asyncio.sleep(0.12)
        # Dynamic grids replace selected pictures. Read the replacements before
        # pressing Verify; never keep clicking an old snapshot's coordinates.
        key = hashlib.sha256((offset['url'] + grid['prompt']).encode()).hexdigest()
        if indices:
            self.grid_history[key] = self.grid_history.get(key, 0) + len(indices)
        if not grid['dynamic'] or not indices:
            if grid.get('verify') and (indices or self.grid_history.get(key) or any(c['selected'] for c in grid['cells'])):
                await self.click(grid['verify'], offset)
                self.grid_history.pop(key, None)
                return {'state': 'submitted', 'engine': result['engine'], 'selected': len(indices), 'label': result['label']}
            if grid.get('reload'):
                await self.click(grid['reload'], offset)
            return {'state': 'no_confident_match', 'refreshed': bool(grid.get('reload'))}
        return {'state': 'selected', 'engine': result['engine'], 'selected': len(indices), 'label': result['label']}

    async def local_widget(self, kind, timeout):
        widget = await self.evaluate(self.page, LOCAL_WIDGET_SCRIPT)
        if not widget or widget.get('kind') != kind or widget.get('unavailable'):
            return {'state': 'unsupported_layout'}
        if kind == 'text':
            png = await self.screenshot(widget['image'])
            result = await asyncio.to_thread(infer, {'kind': 'text', 'image': png}, max(0.1, timeout - 5))
            if result['state'] != 'recognized':
                return result
            latest = await self.evaluate(self.page, LOCAL_WIDGET_SCRIPT)
            if not latest or latest.get('signature') != widget['signature'] or latest.get('input') != widget['input']:
                return {'state': 'challenge_changed'}
            await self.click(widget['input'])
            # Only the single visible, explicitly named CAPTCHA field is edited.
            await self.evaluate(self.page, "const e=document.activeElement;if(!e||!['captcha','captcha_code'].includes(e.name)&&e.autocomplete!=='captcha')throw Error('field changed');e.value='';")
            await self.page.send(cdp.input_.insert_text(result['value']))
            await self.click(widget['submit'])
            return {'state': 'submitted', 'engine': 'ddddocr'}
        result = await asyncio.to_thread(infer, {'kind': 'slider', 'background': widget['background'], 'piece': widget['piece']}, max(0.1, timeout - 5))
        if result['state'] != 'recognized':
            return result
        latest = await self.evaluate(self.page, LOCAL_WIDGET_SCRIPT)
        if latest != widget:
            return {'state': 'challenge_changed'}
        distance = result['x'] * widget['rect']['w'] / result['image_width'] - (widget['piece_rect']['x'] - widget['rect']['x'])
        if not 0 < distance < widget['rect']['w']:
            return {'state': 'uncertain_slider'}
        handle = widget['handle']
        x, y = handle['x'] + handle['w'] / 2, handle['y'] + handle['h'] / 2
        await self.page.send(cdp.input_.dispatch_mouse_event('mousePressed', x=x, y=y, button=cdp.input_.MouseButton.LEFT, buttons=1))
        try:
            for step in range(1, 21):
                await self.page.send(cdp.input_.dispatch_mouse_event('mouseMoved', x=x + distance * step / 20, y=y, buttons=1))
                await asyncio.sleep(0.025)
        finally:
            await self.page.send(cdp.input_.dispatch_mouse_event('mouseReleased', x=x + distance, y=y, button=cdp.input_.MouseButton.LEFT, buttons=0))
        return {'state': 'dragged', 'engine': 'ddddocr'}
