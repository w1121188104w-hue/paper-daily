import base64
import copy
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import cv2
import numpy as np

from captcha_browser import CaptchaBrowser
from captcha_vision import Detector, box_hits_cell, prompt_class, solve_grid, solve_slider, solve_text


def png(image):
    return base64.b64encode(cv2.imencode('.png', image)[1]).decode()


class VisionTests(unittest.TestCase):
    def test_prompt_classes_do_not_guess_unsupported_objects(self):
        self.assertEqual(prompt_class('Select all squares with motorcycles'), 3)
        self.assertEqual(prompt_class('选择包含公共汽车的所有图片'), 5)
        self.assertEqual(prompt_class('包含汽车的所有图片'), 2)
        self.assertIsNone(prompt_class('Select all crosswalks'))

    def test_cells_crossed_by_object_and_tiny_boundary_overlap(self):
        box = dict(x=80, y=10, w=60, h=60)
        self.assertTrue(box_hits_cell(box, dict(x=0, y=0, w=100, h=100)))
        self.assertTrue(box_hits_cell(box, dict(x=100, y=0, w=100, h=100)))
        self.assertFalse(box_hits_cell(box, dict(x=139.9, y=0, w=100, h=100)))

    def test_nine_tiles_clip_negative_edges_without_shift(self):
        shapes = []
        detector = SimpleNamespace(boxes=lambda image, label: shapes.append(image.shape[:2]) or [])
        cells = [dict(x=-2 + 10*(i % 3), y=10*(i // 3), w=10, h=10) for i in range(9)]
        result = solve_grid(dict(prompt='cars', image=png(np.zeros((30, 28, 3), np.uint8)), cells=cells), detector)
        self.assertEqual(result['indices'], [])
        self.assertEqual(shapes[0], (10, 8))
        self.assertEqual(shapes[1], (10, 10))

    def test_sixteen_tiles_use_full_image_and_object_intersections(self):
        cells = [dict(x=100*(i % 4), y=100*(i // 4), w=100, h=100) for i in range(16)]
        detector = SimpleNamespace(boxes=lambda image, label: [dict(x=80,y=120,w=60,h=40)])
        result = solve_grid(dict(prompt='bicycles', image=png(np.zeros((400,400,3),np.uint8)), cells=cells), detector)
        self.assertEqual(result['indices'], [4,5])

    def test_corrupt_model_is_rejected_before_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory)/'model.onnx'
            file.write_bytes(b'not a model')
            with self.assertRaisesRegex(ValueError, 'MODEL_HASH_MISMATCH'):
                Detector(file)

    def test_slider_new_api_center_and_transparent_padding(self):
        piece = np.zeros((40,50,4), np.uint8)
        piece[5:25,7:27] = 255
        request = dict(piece=png(piece),background=png(np.zeros((100,300,3),np.uint8)))
        matcher = SimpleNamespace(slide_match=lambda *args: dict(confidence=.8,target=[130,20]))
        with patch('ddddocr.DdddOcr', return_value=matcher):
            self.assertEqual(solve_slider(request)['x'], 113)
        matcher.slide_match = lambda *args: dict(confidence=.2,target=[130,20])
        with patch('ddddocr.DdddOcr', return_value=matcher):
            self.assertEqual(solve_slider(request)['state'], 'uncertain_slider')

    def test_text_rejects_non_alphanumeric_answer(self):
        with patch('ddddocr.DdddOcr', return_value=SimpleNamespace(classification=lambda image:'not an answer')):
            self.assertEqual(solve_text(dict(image=png(np.zeros((40,150,3),np.uint8))))['state'], 'uncertain_text')


class BrowserTests(unittest.IsolatedAsyncioTestCase):
    def adapter(self, grids):
        adapter = CaptchaBrowser(SimpleNamespace(client=SimpleNamespace(page=SimpleNamespace(send=AsyncMock()))))
        adapter.frame = AsyncMock(return_value=(object(),None,dict(url='https://www.google.com/recaptcha/api2/bframe',x=10,y=10)))
        adapter.evaluate = AsyncMock(side_effect=grids)
        adapter.screenshot = AsyncMock(return_value='image')
        adapter.click = AsyncMock()
        return adapter

    def grid(self, dynamic=False):
        return dict(prompt='cars',dynamic=dynamic,sources=['image'],rect=dict(x=0,y=0,w=300,h=300),
                    cells=[dict(x=(i%3)*100,y=(i//3)*100,w=100,h=100,selected=False) for i in range(9)],
                    verify=dict(x=200,y=330,w=80,h=40),reload=dict(x=0,y=330,w=30,h=40))

    async def test_changed_image_cannot_click_stale_cells(self):
        grid = self.grid()
        changed = copy.deepcopy(grid)
        changed['sources'] = ['replacement']
        adapter = self.adapter([grid,changed])
        with patch('captcha_browser.infer',return_value=dict(state='recognized',indices=[1],engine='test',label=2)):
            self.assertEqual((await adapter.grid(20))['state'], 'challenge_changed')
        adapter.click.assert_not_awaited()

    async def test_dynamic_grid_waits_for_replacements_before_submit(self):
        grid = self.grid(dynamic=True)
        replaced = copy.deepcopy(grid)
        replaced['sources'] = ['replacement']
        adapter = self.adapter([grid,grid,replaced,replaced])
        with patch('captcha_browser.infer',side_effect=[dict(state='recognized',indices=[1],engine='test',label=2),
                                                     dict(state='recognized',indices=[],engine='test',label=2)]):
            self.assertEqual((await adapter.grid(20))['state'],'selected')
            self.assertEqual(adapter.click.await_count,1)
            self.assertEqual((await adapter.grid(20))['state'],'submitted')
            self.assertEqual(adapter.click.await_args.args[0],grid['verify'])

    async def test_unsupported_prompt_refreshes_without_guessing(self):
        grid = self.grid()
        grid['prompt'] = 'crosswalks'
        adapter = self.adapter([grid])
        with patch('captcha_browser.infer') as inference:
            self.assertEqual((await adapter.grid(20))['state'],'unsupported_prompt')
        inference.assert_not_called()
        self.assertEqual(adapter.click.await_args.args[0],grid['reload'])

    async def test_slider_css_scale_and_existing_piece_offset(self):
        widget = dict(kind='slider',background='bg',piece='piece',rect=dict(x=10,y=20,w=300,h=100),
                      piece_rect=dict(x=20,y=20,w=20,h=20),handle=dict(x=10,y=140,w=20,h=20))
        adapter = self.adapter([widget,widget])
        with patch('captcha_browser.infer',return_value=dict(state='recognized',x=240,image_width=600)):
            self.assertEqual((await adapter.local_widget('slider',20))['state'],'dragged')
        # CDP command generators contain the actual dispatched coordinates.
        commands = [next(call.args[0]) for call in adapter.page.send.await_args_list]
        self.assertEqual(commands[-1]['params']['x'],130)  # 20 + 240/2 - 10
        self.assertEqual(commands[-1]['params']['type'],'mouseReleased')

    async def test_iframe_websocket_uses_page_route(self):
        target = SimpleNamespace(type_='iframe',closed=True,target=SimpleNamespace(url='https://www.google.com/recaptcha/api2/bframe',target_id='child'))
        browser = SimpleNamespace(update_targets=AsyncMock(),targets=[target],config=SimpleNamespace(host='127.0.0.1',port=1234))
        adapter = self.adapter([[dict(url=target.target.url,x=10,y=10,w=400,h=500)]])
        del adapter.frame
        adapter.driver.client.driver = browser
        self.assertIs((await adapter.frame())[0],target)
        self.assertEqual(target.websocket_url,'ws://127.0.0.1:1234/devtools/page/child')


if __name__ == '__main__':
    unittest.main()
