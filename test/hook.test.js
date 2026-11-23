// 5단계: 브라우저 API 훅 (src/client/hook.js) — jsdom 환경에서 서버가 내보내는 번들 그대로 실행
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildHookScript, stripModuleSyntax } from '../src/server/hook-bundle.js';

const PROXY = 'http://localhost:8080';
const SITE = 'https://www.example.com';
const PAGE = `${PROXY}/p/${SITE}/dir/page?x=1`;
let bundle;

before(async () => {
  bundle = await buildHookScript();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * jsdom 창을 만들고, jsdom에 없거나 실제 네트워크를 쓰는 API를 기록용 스텁으로 바꾼 뒤 훅을 실행한다.
 * @param {{ url?: string, cookie?: string, referrer?: string, respond?: Function, beforeHook?: Function }} [opts]
 */
function setup({ url = PAGE, cookie = '', referrer, respond, beforeHook } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head><script src="/__proxy/hook.js" data-proxy-cookie="${cookie}"></script></head><body></body></html>`,
    { url, referrer, runScripts: 'outside-only' },
  );
  const w = dom.window;
  const calls = { fetch: [], xhr: [], beacon: [], open: [], es: [], ws: [] };

  w.fetch = function fetch(input, init) {
    calls.fetch.push({ input, init });
    const res = respond?.(input, init) ?? {};
    return Promise.resolve({
      ok: true,
      headers: { get: (name) => res.headers?.[name.toLowerCase()] ?? null },
      json: async () => res.json ?? {},
    });
  };
  w.XMLHttpRequest.prototype.open = function open(method, u) {
    calls.xhr.push({ method, url: u });
  };
  w.Navigator.prototype.sendBeacon = function sendBeacon(u, data) {
    calls.beacon.push({ url: u, data });
    return true;
  };
  w.open = function open(u, target) {
    calls.open.push({ url: u, target });
    return null;
  };
  w.EventSource = class EventSource {
    static CONNECTING = 0;
    constructor(u, opts) {
      this.url = u;
      calls.es.push({ url: u, opts });
    }
  };
  w.WebSocket = class WebSocket {
    constructor(u, protocols) {
      this.url = u;
      calls.ws.push({ url: u, protocols });
    }
  };
  // 훅 설치 전 원래 함수의 toString (native 위장 검사용)
  const originals = {
    fetch: Function.prototype.toString.call(w.fetch),
    xhrOpen: Function.prototype.toString.call(w.XMLHttpRequest.prototype.open),
    setAttribute: Function.prototype.toString.call(w.Element.prototype.setAttribute),
    srcSetter: Function.prototype.toString.call(Object.getOwnPropertyDescriptor(w.HTMLImageElement.prototype, 'src').set),
    cookieGetter: Function.prototype.toString.call(Object.getOwnPropertyDescriptor(w.Document.prototype, 'cookie').get),
    WebSocket: Function.prototype.toString.call(w.WebSocket),
    toString: Function.prototype.toString.call(Function.prototype.toString),
  };
  const rawLocalStorage = w.localStorage;
  beforeHook?.(w);
  w.eval(bundle);
  calls.fetch.length = 0; // 설치 시점의 쿠키 확인 요청은 제외
  return { w, d: w.document, calls, originals, rawLocalStorage };
}

// ---------------------------------------------------------------------------

test('번들: url.js의 export가 제거된 일반 스크립트', () => {
  assert.doesNotMatch(bundle, /^\s*(import|export)\b/m);
  assert.throws(() => stripModuleSyntax("import x from 'y';"), /import\/export/);
  assert.doesNotThrow(() => new Function(bundle));
});

test('window.__proxy: 원본 URL, origin, 변환 함수 (열거되지 않음)', () => {
  const { w } = setup();
  assert.equal(w.__proxy.url, `${SITE}/dir/page?x=1`);
  assert.equal(w.__proxy.origin, SITE);
  assert.equal(w.__proxy.proxyOrigin, PROXY);
  assert.equal(w.__proxy.toProxy('/a'), `/p/${SITE}/a`);
  assert.equal(w.__proxy.fromProxy(`${PROXY}/p/${SITE}/b?c=1`), `${SITE}/b?c=1`);
  assert.equal(w.__proxy.fromProxy('https://other.com/'), null);
  assert.equal(Object.keys(w).includes('__proxy'), false);
  // 두 번 실행해도 다시 설치하지 않음
  const before = w.__proxy;
  w.eval(bundle);
  assert.equal(w.__proxy, before);
});

test('fetch: 상대/루트 상대/절대/프로토콜 상대/URL 객체 -> 프록시 경로, init 유지', async () => {
  const { w, calls } = setup();
  const init = { method: 'POST', body: 'x', credentials: 'include', headers: { 'x-a': '1' } };
  await w.fetch('api/a', init);
  await w.fetch('/api/b?q=1');
  await w.fetch('https://api.other.com/c');
  await w.fetch('//cdn.example.net/d.js');
  await w.fetch(new w.URL('https://u.example.com/e'));
  await w.fetch(`/p/${SITE}/already`);
  await w.fetch(`${PROXY}/api/root`); // 브라우저가 localhost 기준으로 해석해 버린 루트 상대 URL
  await w.fetch('data:text/plain,hi');
  assert.deepEqual(calls.fetch.map((c) => c.input), [
    `/p/${SITE}/dir/api/a`,
    `/p/${SITE}/api/b?q=1`,
    '/p/https://api.other.com/c',
    '/p/https://cdn.example.net/d.js',
    '/p/https://u.example.com/e',
    `/p/${SITE}/already`,
    `/p/${SITE}/api/root`,
    'data:text/plain,hi',
  ]);
  assert.equal(calls.fetch[0].init, init);
});

test('XMLHttpRequest.open / sendBeacon / EventSource', () => {
  const { w, calls } = setup();
  const xhr = new w.XMLHttpRequest();
  xhr.open('GET', '/api/x', true);
  xhr.open('POST', 'https://api.other.com/y');
  w.navigator.sendBeacon('/log', 'payload');
  const es = new w.EventSource('/events', { withCredentials: true });
  assert.deepEqual(calls.xhr, [
    { method: 'GET', url: `/p/${SITE}/api/x` },
    { method: 'POST', url: '/p/https://api.other.com/y' },
  ]);
  assert.deepEqual(calls.beacon, [{ url: `/p/${SITE}/log`, data: 'payload' }]);
  assert.deepEqual(calls.es, [{ url: `/p/${SITE}/events`, opts: { withCredentials: true } }]);
  // Proxy로 감쌌으므로 정적 상수와 instanceof가 유지됨
  assert.equal(w.EventSource.CONNECTING, 0);
  assert.ok(es instanceof w.EventSource);
});

test('WebSocket: ws://localhost:PORT/__proxy/ws?url=... , 서브클래스도 동작', () => {
  const { w, calls } = setup();
  new w.WebSocket('wss://chat.example.com/socket?room=1', ['v1']);
  new w.WebSocket('/live'); // 상대 URL은 원본 기준, https -> wss
  class MySocket extends w.WebSocket {}
  const s = new MySocket('ws://x.com/');
  // 페이지의 원본 origin도 함께 보낸다 (서버가 Origin 헤더를 원본 기준으로 맞추도록, 7단계)
  const origin = `&origin=${encodeURIComponent(SITE)}`;
  assert.deepEqual(calls.ws.map((c) => c.url), [
    `ws://localhost:8080/__proxy/ws?url=${encodeURIComponent('wss://chat.example.com/socket?room=1')}${origin}`,
    `ws://localhost:8080/__proxy/ws?url=${encodeURIComponent('wss://www.example.com/live')}${origin}`,
    `ws://localhost:8080/__proxy/ws?url=${encodeURIComponent('ws://x.com/')}${origin}`,
  ]);
  assert.deepEqual(calls.ws[0].protocols, ['v1']);
  assert.ok(s instanceof MySocket);
});

test('window.open, history.pushState/replaceState', () => {
  const { w, calls } = setup();
  w.open('/popup', '_blank');
  w.open();
  w.history.pushState({ a: 1 }, '', '/new/path?y=2');
  assert.equal(w.location.pathname, `/p/${SITE}/new/path`);
  assert.equal(w.location.search, '?y=2');
  assert.equal(w.__proxy.url, `${SITE}/new/path?y=2`);
  assert.deepEqual(w.history.state, { a: 1 });
  w.history.replaceState(null, '', 'relative');
  assert.equal(w.__proxy.url, `${SITE}/new/relative`);
  w.history.pushState(null, ''); // URL 없이
  assert.equal(w.__proxy.url, `${SITE}/new/relative`);
  assert.deepEqual(calls.open, [{ url: `/p/${SITE}/popup`, target: '_blank' }, { url: undefined, target: undefined }]);
});

test('요소 속성 대입: src/href/action/srcset/poster/data/formAction', () => {
  const { d } = setup();
  const el = (tag) => d.createElement(tag);
  const img = el('img');
  img.src = '/a.png';
  img.srcset = '/a1.png 1x, //cdn.example.net/a2.png 2x';
  const a = el('a');
  a.href = 'https://other.com/x';
  const form = el('form');
  form.action = '/submit';
  const video = el('video');
  video.poster = 'p.jpg';
  video.src = '/v.mp4';
  const obj = el('object');
  obj.data = '/movie.swf';
  const btn = el('button');
  btn.formAction = '/alt';
  const script = el('script');
  script.src = 'https://cdn.example.net/lib.js';
  assert.equal(img.getAttribute('src'), `/p/${SITE}/a.png`);
  assert.equal(img.getAttribute('srcset'), `/p/${SITE}/a1.png 1x, /p/https://cdn.example.net/a2.png 2x`);
  assert.equal(a.getAttribute('href'), '/p/https://other.com/x');
  assert.equal(form.getAttribute('action'), `/p/${SITE}/submit`);
  assert.equal(video.getAttribute('poster'), `/p/${SITE}/dir/p.jpg`);
  assert.equal(video.getAttribute('src'), `/p/${SITE}/v.mp4`);
  assert.equal(obj.getAttribute('data'), `/p/${SITE}/movie.swf`);
  // jsdom에는 formAction 속성이 없다 (브라우저에는 있음, e2e에서 확인)
  if (Object.getOwnPropertyDescriptor(btn.constructor.prototype, 'formAction')) {
    assert.equal(btn.getAttribute('formaction'), `/p/${SITE}/alt`);
  }
  assert.equal(script.getAttribute('src'), '/p/https://cdn.example.net/lib.js');
  // getter는 원래대로 (절대 URL)
  assert.equal(img.src, `${PROXY}/p/${SITE}/a.png`);
});

test('프록시 대상이 아닌 값과 이미 프록시된 값은 그대로 (이중 변환 없음)', () => {
  const { d } = setup();
  const a = d.createElement('a');
  for (const v of ['#top', 'javascript:void(0)', 'mailto:a@b.c', '', `/p/${SITE}/x`, `${PROXY}/p/${SITE}/y`, '/__proxy/cookies']) {
    a.href = v;
    assert.equal(a.getAttribute('href'), v, v);
  }
  // 다른 요소의 (프록시된) href를 그대로 대입하는 흔한 패턴
  const b = d.createElement('a');
  a.href = '/one';
  b.href = a.href;
  assert.equal(b.getAttribute('href'), `${PROXY}/p/${SITE}/one`);
});

test('setAttribute / setAttributeNS, integrity는 무시', () => {
  const { d } = setup();
  const img = d.createElement('img');
  img.setAttribute('SRC', '/b.png');
  img.setAttribute('alt', '/not-a-url');
  const div = d.createElement('div');
  div.setAttribute('data', '/not-a-url'); // data는 <object>에서만 URL
  const svgImg = d.createElementNS('http://www.w3.org/2000/svg', 'image');
  svgImg.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '/s.png');
  const use = d.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#icon');
  const script = d.createElement('script');
  script.setAttribute('integrity', 'sha384-x');
  script.integrity = 'sha384-y';
  assert.equal(img.getAttribute('src'), `/p/${SITE}/b.png`);
  assert.equal(img.getAttribute('alt'), '/not-a-url');
  assert.equal(div.getAttribute('data'), '/not-a-url');
  assert.equal(svgImg.getAttributeNS('http://www.w3.org/1999/xlink', 'href'), `/p/${SITE}/s.png`);
  assert.equal(use.getAttribute('href'), '#icon');
  assert.equal(script.hasAttribute('integrity'), false);
});

test('innerHTML / outerHTML / insertAdjacentHTML 로 넣은 요소도 변환', () => {
  const { d } = setup();
  const box = d.createElement('div');
  d.body.append(box);
  box.innerHTML = '<img src="/i.png" srcset="/i2.png 2x"><a href="//other.com/l">l</a><template><img src="/t.png"></template><p>src=/text</p>';
  assert.equal(box.querySelector('img').getAttribute('src'), `/p/${SITE}/i.png`);
  assert.equal(box.querySelector('img').getAttribute('srcset'), `/p/${SITE}/i2.png 2x`);
  assert.equal(box.querySelector('a').getAttribute('href'), '/p/https://other.com/l');
  assert.equal(box.querySelector('template').content.querySelector('img').getAttribute('src'), `/p/${SITE}/t.png`);
  assert.equal(box.querySelector('p').textContent, 'src=/text');

  box.insertAdjacentHTML('beforeend', '<script src="/s.js" integrity="sha-x"></script>');
  const s = box.querySelector('script');
  assert.equal(s.getAttribute('src'), `/p/${SITE}/s.js`);
  assert.equal(s.hasAttribute('integrity'), false);

  const target = d.createElement('span');
  box.append(target);
  target.outerHTML = '<iframe src="/frame"></iframe>';
  assert.equal(box.querySelector('iframe').getAttribute('src'), `/p/${SITE}/frame`);

  // 표 문맥, URL 속성이 없는 HTML, <style>/<script> 원문은 그대로
  const table = d.createElement('table');
  table.innerHTML = '<tbody><tr><td><img src="/td.png"></td></tr></tbody>';
  assert.equal(table.querySelector('img').getAttribute('src'), `/p/${SITE}/td.png`);
  const style = d.createElement('style');
  style.innerHTML = 'a > b { background: url(x.png) } /* src="/x" */';
  assert.equal(style.textContent, 'a > b { background: url(x.png) } /* src="/x" */');
});

test('document.URL / documentURI / domain / referrer', () => {
  const { d } = setup({ referrer: `${PROXY}/p/https://search.example.org/q?s=1` });
  assert.equal(d.URL, `${SITE}/dir/page?x=1`);
  assert.equal(d.documentURI, `${SITE}/dir/page?x=1`);
  assert.equal(d.domain, 'www.example.com');
  d.domain = 'example.com'; // 무시 (에러 없이)
  assert.equal(d.domain, 'www.example.com');
  assert.equal(d.referrer, 'https://search.example.org/q?s=1');
  // 시작 페이지(프록시 밖)에서 왔으면 빈 문자열
  assert.equal(setup({ referrer: `${PROXY}/` }).d.referrer, '');
  assert.equal(setup().d.referrer, '');
});

test('__proxy.location: 원본 기준 값, toString, 해시 변경', () => {
  const { w } = setup({ url: `${PAGE}#sec` });
  const loc = w.__proxy.location;
  assert.equal(loc.href, `${SITE}/dir/page?x=1#sec`);
  assert.equal(loc.protocol, 'https:');
  assert.equal(loc.host, 'www.example.com');
  assert.equal(loc.hostname, 'www.example.com');
  assert.equal(loc.port, '');
  assert.equal(loc.origin, SITE);
  assert.equal(loc.pathname, '/dir/page');
  assert.equal(loc.search, '?x=1');
  assert.equal(loc.hash, '#sec');
  assert.equal(String(loc), `${SITE}/dir/page?x=1#sec`);
  assert.equal(`${loc}`, loc.href);
  assert.equal(Object.prototype.toString.call(loc), '[object Location]');
  loc.hash = 'other';
  assert.equal(w.location.hash, '#other');
  assert.equal(loc.href, `${SITE}/dir/page?x=1#other`);
  assert.equal(typeof loc.assign, 'function');
  assert.equal(typeof loc.replace, 'function');
  assert.equal(typeof loc.reload, 'function');
});

test('document.cookie: 초기값은 서버가 넣어 준 속성, 쓰기는 캐시 즉시 반영 + 서버 API로 전송', async () => {
  const { w, d, calls } = setup({
    cookie: 'a=1; b=2',
    respond: (input, init) => (init?.method === 'POST' ? { json: { cookie: 'a=1; b=2; c=3' } } : undefined),
  });
  assert.equal(d.cookie, 'a=1; b=2');
  // 속성은 읽은 뒤 지워서 페이지가 보지 못하게
  assert.equal(d.querySelector('script').hasAttribute('data-proxy-cookie'), false);

  d.cookie = 'c=3; path=/';
  assert.equal(d.cookie, 'a=1; b=2; c=3');
  assert.equal(calls.fetch.length, 1);
  const { input, init } = calls.fetch[0];
  assert.equal(input, `/__proxy/cookies?url=${encodeURIComponent(`${SITE}/dir/page?x=1`)}`);
  assert.equal(init.method, 'POST');
  assert.equal(init.body, 'c=3; path=/');
  assert.equal(init.credentials, 'same-origin');
  await tick();
  await tick();
  assert.equal(d.cookie, 'a=1; b=2; c=3');

  d.cookie = 'a=; max-age=0';
  assert.equal(d.cookie, 'b=2; c=3');
  d.cookie = 'h=1; HttpOnly'; // JS로 HttpOnly 불가
  assert.equal(d.cookie.includes('h=1'), false);
  assert.equal(w.document.cookie, d.cookie);
});

test('document.cookie: 응답 헤더(x-proxy-document-cookie)로 캐시 갱신, 오래된 응답은 무시', async () => {
  let header = encodeURIComponent('sid=new; theme=dark');
  const { w, d } = setup({ cookie: 'sid=old', respond: () => ({ headers: { 'x-proxy-document-cookie': header } }) });
  await w.fetch('/login');
  await tick();
  assert.equal(d.cookie, 'sid=new; theme=dark');

  // 요청 중에 document.cookie 쓰기가 있었으면 그 요청의 헤더 값은 버린다
  header = encodeURIComponent('sid=stale');
  const pending = w.fetch('/slow');
  d.cookie = 'mine=1';
  await pending;
  await tick();
  assert.equal(d.cookie.includes('sid=stale'), false);
  assert.equal(d.cookie.includes('mine=1'), true);
});

test('document.cookie: 사이트마다 자기 URL로 API를 호출하고 캐시도 따로', () => {
  const a = setup({ url: `${PROXY}/p/https://site-a.com/`, cookie: 'session=AAA' });
  const b = setup({ url: `${PROXY}/p/https://site-b.com/`, cookie: 'session=BBB' });
  assert.equal(a.d.cookie, 'session=AAA');
  assert.equal(b.d.cookie, 'session=BBB');
  a.d.cookie = 'x=1';
  b.d.cookie = 'x=2';
  assert.match(a.calls.fetch[0].input, /url=https%3A%2F%2Fsite-a\.com%2F$/);
  assert.match(b.calls.fetch[0].input, /url=https%3A%2F%2Fsite-b\.com%2F$/);
  assert.equal(a.d.cookie, 'session=AAA; x=1');
  assert.equal(b.d.cookie, 'session=BBB; x=2');
});

test('localStorage/sessionStorage: 원본 origin 접두사로 사이트별 분리', () => {
  const { w, rawLocalStorage } = setup();
  const S = w.Storage.prototype;
  // 다른 사이트가 같은 키로 저장해 둔 값 (같은 localhost 저장소를 공유)
  S.setItem.call(rawLocalStorage, 'https://other.com::token', 'OTHER');
  const ls = w.localStorage;

  ls.setItem('token', 'MINE');
  assert.equal(S.getItem.call(rawLocalStorage, `${SITE}::token`), 'MINE');
  assert.equal(ls.getItem('token'), 'MINE');
  assert.equal(ls.getItem('missing'), null);

  ls.theme = 'dark'; // 속성 문법
  assert.equal(ls.theme, 'dark');
  assert.equal(ls['token'], 'MINE');
  assert.equal('theme' in ls, true);
  assert.equal('nope' in ls, false);
  assert.deepEqual(Object.keys(ls).sort(), ['theme', 'token']);
  assert.equal(ls.length, 2);
  assert.ok(['theme', 'token'].includes(ls.key(0)));
  assert.equal(ls.key(5), null);
  assert.ok(ls instanceof w.Storage);

  delete ls.theme;
  assert.equal(ls.getItem('theme'), null);
  ls.removeItem('token');
  ls.setItem('k', '1');
  ls.clear(); // 자기 사이트 것만
  assert.equal(ls.length, 0);
  assert.equal(S.getItem.call(rawLocalStorage, 'https://other.com::token'), 'OTHER');

  w.sessionStorage.setItem('s', '1');
  assert.equal(w.sessionStorage.getItem('s'), '1');
});

test('덮어쓴 함수의 toString()/name/length가 원래 함수와 같음', () => {
  const { w, originals } = setup();
  const ts = (f) => w.Function.prototype.toString.call(f);
  assert.equal(ts(w.fetch), originals.fetch);
  assert.equal(w.fetch.toString(), originals.fetch);
  assert.equal(String(w.fetch), originals.fetch);
  assert.equal(ts(w.XMLHttpRequest.prototype.open), originals.xhrOpen);
  assert.equal(ts(w.Element.prototype.setAttribute), originals.setAttribute);
  assert.equal(ts(Object.getOwnPropertyDescriptor(w.HTMLImageElement.prototype, 'src').set), originals.srcSetter);
  assert.equal(ts(Object.getOwnPropertyDescriptor(w.Document.prototype, 'cookie').get), originals.cookieGetter);
  assert.equal(ts(w.WebSocket), originals.WebSocket);
  assert.equal(ts(w.Function.prototype.toString), originals.toString);
  assert.equal(w.Function.prototype.toString.toString(), originals.toString);
  assert.equal(w.fetch.name, 'fetch');
  assert.equal(w.Element.prototype.setAttribute.name, 'setAttribute');
  assert.equal(w.Element.prototype.setAttribute.length, 2);
  assert.equal(w.fetch.prototype, undefined); // native 메서드처럼 prototype 없음
  // 훅과 무관한 함수는 원래 소스 그대로
  assert.equal(ts(function hello() { return 1; }), 'function hello() { return 1; }');
});

// ---------------------------------------------------------------------------
// 6단계: js.js 변환 결과가 부르는 __proxy.get/set/top/parent/rewrite
// ---------------------------------------------------------------------------
import { buildRewriterScript } from '../src/server/hook-bundle.js';
import { rewriteJs } from '../src/rewrite/js.js';

let rewriterBundle;
before(async () => {
  rewriterBundle = await buildRewriterScript();
});
// 변환기 번들을 미리 넣어 두면 hook 이 동기 XHR 없이 바로 쓴다 (window[Symbol.for('proxy.rewriter')])
const setupWithRewriter = (opts = {}) => setup({ ...opts, beforeHook: (w) => w.eval(rewriterBundle) });

test('__proxy.get: 창/문서의 location/top/parent는 가짜, 나머지는 그대로', () => {
  const { w, d } = setup();
  const P = w.__proxy;
  assert.equal(P.get(w, 'location'), P.location);
  assert.equal(P.get(w, 'loc' + 'ation').href, `${SITE}/dir/page?x=1`);
  assert.equal(P.get(d, 'location'), P.location);
  assert.equal(P.get(w, 'top'), w);
  assert.equal(P.get({ location: 'mine' }, 'location'), 'mine');
  assert.equal(P.get([10, 20], 1), 20);
  assert.equal(P.get({ a: 1 }, { toString: () => 'a' }), 1);
  const sym = Symbol('s');
  assert.equal(P.get({ [sym]: 3 }, sym), 3);
  assert.throws(() => P.get(null, 'x'), { name: 'TypeError' }); // jsdom 창(다른 realm)의 TypeError
});

test('__proxy.set: location 대입은 가짜 location 으로, 나머지는 일반 대입 (읽기 전용은 조용히 무시)', () => {
  const { w } = setup();
  const P = w.__proxy;
  const o = {};
  assert.equal(P.set(o, 'k', 1), 1);
  assert.equal(o.k, 1);
  P.set(w, 'location', '#moved'); // jsdom 은 해시 이동만 지원
  assert.equal(w.location.hash, '#moved');
  const frozen = Object.freeze({ a: 1 });
  assert.equal(P.set(frozen, 'a', 2), 2);
  assert.equal(frozen.a, 1);
  assert.equal(P.set('str', 'x', 1), 1);
  assert.throws(() => P.set(undefined, 'x', 1), { name: 'TypeError' });
});

test('__proxy.top / parent: 최상위 창이면 자기 자신, __proxy.location 대입', () => {
  const { w } = setup();
  assert.equal(w.__proxy.top, w);
  assert.equal(w.__proxy.parent, w);
  w.__proxy.location = '#via-setter';
  assert.equal(w.location.hash, '#via-setter');
});

test('서버에서 변환한 코드를 실행하면 원본 주소를 본다 (window["loc"+"ation"] 포함)', () => {
  const { w, d } = setup({ url: `${PAGE}#start` });
  w.eval(rewriteJs(`
    document.title = location.href + ' | ' + window['loc' + 'ation'].host + ' | ' + (top === window) + ' | ' + document.location.pathname;
    window['loc' + 'ation'].hash = 'set-by-computed';
  `));
  assert.equal(d.title, `${SITE}/dir/page?x=1#start | www.example.com | true | /dir/page`);
  assert.equal(w.location.hash, '#set-by-computed');
});

test('__proxy.rewrite: eval / new Function / setTimeout 문자열 코드도 변환', async () => {
  const timers = [];
  const { w } = setup({
    beforeHook: (win) => {
      win.eval(rewriterBundle);
      // jsdom(outside-only)은 문자열 타이머를 실행하지 않으므로, 넘겨지는 값을 기록해 확인
      win.setTimeout = function setTimeout(handler, ms) {
        timers.push(handler);
        return 1;
      };
    },
  });
  // 서버 변환 결과: eval(__proxy.rewrite(code)) — 변환된 eval 코드가 가짜 location 을 본다
  assert.equal(w.eval(rewriteJs('eval("location.hostname")')), 'www.example.com');
  assert.equal(w.eval(rewriteJs('new Function("return location.origin")()')), SITE);
  // 지역 변수에 접근하는 direct eval 이 유지됨
  assert.equal(w.eval(rewriteJs('(function () { var secret = 42; return eval("secret + 1"); })()')), 43);
  w.setTimeout('window.__fromTimeout = location.pathname', 0);
  const fn = () => 1;
  w.setTimeout(fn, 0);
  assert.equal(w.eval(timers[0]), '/dir/page'); // 변환된 문자열을 실행하면 원본 경로
  assert.equal(timers[1], fn); // 함수는 그대로
  // 바꿀 것이 없는 코드는 그대로
  assert.equal(w.__proxy.rewrite('1 + 1'), '1 + 1');
  assert.equal(w.__proxy.rewrite(42), 42);
});

test('동적 코드: on* 속성, <script> 본문(text/textContent/innerHTML), innerHTML 안의 on*', () => {
  const { d } = setupWithRewriter();
  const btn = d.createElement('button');
  btn.setAttribute('onclick', 'location.href = "/x"; return false;');
  assert.match(btn.getAttribute('onclick'), /__proxy\.location\.href = "\/x"/);
  const s1 = d.createElement('script');
  s1.text = 'top.location = "/a"';
  assert.match(s1.text, /__proxy\.set\(__proxy\.top, "location", "\/a"\)/);
  const s2 = d.createElement('script');
  s2.textContent = 'window.location.reload()';
  assert.match(s2.textContent, /__proxy\.location\.reload\(\)/);
  const s3 = d.createElement('script');
  s3.innerHTML = 'parent.postMessage(1)';
  assert.match(s3.textContent, /__proxy\.parent\.postMessage/);
  const json = d.createElement('script');
  json.setAttribute('type', 'application/json');
  json.textContent = '{"location": [1]}';
  assert.equal(json.textContent, '{"location": [1]}');
  const box = d.createElement('div');
  box.innerHTML = '<a onclick="location.assign(\'/y\')">y</a>';
  assert.match(box.firstChild.getAttribute('onclick'), /__proxy\.location\.assign/);
  // 일반 텍스트 노드의 textContent 는 그대로
  const p = d.createElement('p');
  p.textContent = 'location.href';
  assert.equal(p.textContent, 'location.href');
});

// ---------------------------------------------------------------------------
// window.opener / window.close(): 프록시 밖의 창이 연 탭은 사용자가 직접 연 탭처럼
// ---------------------------------------------------------------------------
function setupWithOpener(opener) {
  let closed = 0;
  const ctx = setup({
    beforeHook: (w) => {
      Object.defineProperty(w, 'opener', { get: () => opener, set() {}, configurable: true });
      w.close = function close() {
        closed++;
      };
    },
  });
  return { ...ctx, closedCount: () => closed };
}

test('프록시 밖의 창(Codespaces 편집기 등)이 연 탭: opener 숨김, window.close() 무시', () => {
  const outsider = {}; // __proxy 가 없는 창 (다른 origin 편집기, 시작 페이지 등)
  const { w, closedCount } = setupWithOpener(outsider);
  assert.equal(w.opener, null);
  w.close();
  assert.equal(closedCount(), 0);
});

test('프록시된 페이지가 연 팝업: opener 보이고 window.close() 동작 (로그인 팝업 흐름)', () => {
  const proxiedParent = { __proxy: { url: 'https://site.com/' } };
  const { w, closedCount } = setupWithOpener(proxiedParent);
  assert.equal(w.opener, proxiedParent);
  w.close();
  assert.equal(closedCount(), 1);
});

test('opener 없이 연 탭: opener 는 null, close() 는 브라우저 기본 동작에 맡기지 않고 무시', () => {
  const { w, closedCount } = setupWithOpener(null);
  assert.equal(w.opener, null);
  w.close();
  assert.equal(closedCount(), 0);
  // native 처럼 보임
  assert.equal(w.close.name, 'close');
});
