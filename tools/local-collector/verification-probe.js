// Return only diagnostic enums/booleans; never collect tokens or form values.
const visible = e => {const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
const has = selector => [...document.querySelectorAll(selector)].some(visible);
const frames = [...document.querySelectorAll('iframe')].filter(visible).map(e=>({src:e.getAttribute('src')||'',title:e.title||''}));
const text=(document.title+' '+(document.body?.innerText||'').slice(0,1800)).toLowerCase();
let provider='unknown',kind='unknown',component=false;
const scriptSources=[...document.scripts].map(e=>e.src);
if(scriptSources.some(s=>/challenges\.cloudflare\.com\/turnstile|\/cdn-cgi\/challenge-platform\//.test(s)))provider='cloudflare';
if(frames.some(f=>/recaptcha/i.test(f.src))||has('.g-recaptcha')){provider='recaptcha';component=true;kind='checkbox';}
if(frames.some(f=>/hcaptcha|Incapsula_Resource/i.test(f.src))||has('.h-captcha')){provider='hcaptcha';component=true;kind='checkbox';}
if(frames.some(f=>/challenges.cloudflare/i.test(f.src))||has('.cf-turnstile,#challenge-stage,#challenge-running')){provider='cloudflare';component=true;kind='automatic';}
if(frames.some(f=>/friendlycaptcha/i.test(f.src))||has('iframe[data--frc-frame-id],.frc-captcha')){provider='friendlycaptcha';component=true;kind='automatic';}
if(frames.some(f=>/recaptcha.*\/bframe/i.test(f.src)||/challenge expires|main content of.*challenge/i.test(f.title))||has('.rc-imageselect,.hcaptcha-challenge'))kind='image';
else if(has('.geetest_slider,.geetest_slider_button,.yidun_slider,.nc_wrapper')){kind='slider';component=true;}
else if(has('input[name="captcha"],input[name="captcha_code"],input[autocomplete="captcha"]')&&has('img[src*="captcha"],img[id*="captcha"]')){kind='text';component=true;}
else if(/checking your browser|performing security verification|just a moment|请稍候/.test(text)&&!component)kind='automatic';
const access=!component&&/too many requests|rate limit exceeded|error 1015/.test(text)?'rate_limited':
  !component&&/access denied|you have been blocked|error 1020/.test(text)?'access_denied':
  /\/(?:login|signin)(?:\/|$)/i.test(location.pathname)&&has('input[type="password"]')?'login_required':null;
const expired=component&&/verification expired|challenge expired|验证已过期/.test(text);
const load_failed=component&&/failed to load|unable to connect|加载失败/.test(text);
const solved=!!document.querySelector('textarea[name="g-recaptcha-response"],textarea[name="h-captcha-response"],input[name="cf-turnstile-response"]')?.value?.trim();
const continue_required=solved&&location.hostname==='academic.oup.com'&&location.pathname.startsWith('/crawlprevention/')&&has('#btnSubmit:not([disabled])');
return {provider,kind,component,access,expired,load_failed,solved,continue_required};
