// 4단계: 서비스 워커의 요청 URL -> 프록시 URL 변환 로직 (src/shared/url.js 의 rewriteRequestUrl)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteRequestUrl } from '../src/shared/url.js';
import { createProxyServer } from '../src/server/index.js';

const P = 'http://localhost:8080';
const PAGE = `${P}/p/https://www.example.com/app/page?x=1`;
const rw = (url, ctx) => rewriteRequestUrl(url, { proxyOrigin: P, ...ctx });

test('이미 프록시 경로(/p/, /__proxy/)는 그대로 (null)', () => {
  assert.equal(rw(`${P}/p/https://www.example.com/a`, { clientUrl: PAGE }), null);
  assert.equal(rw(`${P}/__proxy/hook.js`, { clientUrl: PAGE }), null);
  assert.equal(rw(`${P}/__proxy/cookies?url=x`, { clientUrl: PAGE }), null);
});

test('루트 상대 요청: 요청한 페이지의 원본 사이트 기준으로 변환', () => {
  // fetch('/api/data?q=1') 가 localhost 기준으로 해석된 것
  assert.equal(rw(`${P}/api/data?q=1`, { clientUrl: PAGE }), `${P}/p/https://www.example.com/api/data?q=1`);
  assert.equal(rw(`${P}/`, { clientUrl: PAGE }), `${P}/p/https://www.example.com/`);
  // 경로가 /p 로 시작하지만 /p/ 는 아닌 경우는 사이트 경로
  assert.equal(rw(`${P}/pages/1`, { clientUrl: PAGE }), `${P}/p/https://www.example.com/pages/1`);
  // 원본 사이트의 포트/프로토콜 유지
  assert.equal(
    rw(`${P}/x.js`, { clientUrl: `${P}/p/http://127.0.0.1:3000/index.html` }),
    `${P}/p/http://127.0.0.1:3000/x.js`,
  );
});

test('clientUrl을 모르면 referrer로 판단, 둘 다 프록시 페이지가 아니면 null', () => {
  assert.equal(rw(`${P}/next`, { referrer: PAGE }), `${P}/p/https://www.example.com/next`);
  // about:blank / srcdoc iframe 같은 클라이언트는 referrer로
  assert.equal(rw(`${P}/next`, { clientUrl: 'about:srcdoc', referrer: PAGE }), `${P}/p/https://www.example.com/next`);
  // 시작 페이지에서 보낸 요청, 주소창 직접 입력(referrer 없음)
  assert.equal(rw(`${P}/favicon.ico`, { clientUrl: `${P}/` }), null);
  assert.equal(rw(`${P}/`, {}), null);
  assert.equal(rw(`${P}/x`, { referrer: '' }), null);
  // 다른 origin의 referrer는 프록시 페이지가 아님
  assert.equal(rw(`${P}/x`, { referrer: 'https://www.example.com/p/https://a.com/' }), null);
});

test('다른 origin 요청: 그 URL 자체를 프록시 (요청한 페이지와 무관)', () => {
  assert.equal(
    rw('https://api.example.net/v1/items?id=3', { clientUrl: PAGE }),
    `${P}/p/https://api.example.net/v1/items?id=3`,
  );
  assert.equal(rw('http://cdn.example.org/a.png', {}), `${P}/p/http://cdn.example.org/a.png`);
  // 프록시와 포트만 다른 localhost도 다른 origin
  assert.equal(rw('http://localhost:3000/x', { clientUrl: PAGE }), `${P}/p/http://localhost:3000/x`);
});

test('http(s)가 아닌 요청과 잘못된 URL은 null', () => {
  assert.equal(rw('chrome-extension://abc/x.js', { clientUrl: PAGE }), null);
  assert.equal(rw('data:text/plain,hi', { clientUrl: PAGE }), null);
  assert.equal(rw('not a url', { clientUrl: PAGE }), null);
});

test('변환 결과는 항상 프록시 origin의 /p/ 경로 (다시 변환하면 null = 무한 루프 없음)', () => {
  const samples = [
    [`${P}/api/x`, { clientUrl: PAGE }],
    ['https://other.com/y', {}],
    [`${P}/z`, { referrer: PAGE }],
  ];
  for (const [url, ctx] of samples) {
    const out = rw(url, ctx);
    assert.ok(out.startsWith(`${P}/p/`), out);
    assert.equal(rw(out, ctx), null);
  }
});

// ---------- 서버: 클라이언트 자원 제공 ----------

let proxy, proxyUrl;
before(async () => {
  proxy = createProxyServer();
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
});
after(() => {
  proxy.closeAllConnections();
  proxy.close();
});

test('/__proxy/sw.js: Service-Worker-Allowed: / 와 JS MIME', async () => {
  const res = await fetch(`${proxyUrl}/__proxy/sw.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('service-worker-allowed'), '/');
  assert.match(res.headers.get('content-type'), /^text\/javascript/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const body = await res.text();
  // 모듈 워커: url.js 를 같은 디렉터리(/__proxy/url.js)에서 import
  assert.match(body, /from '\.\/url\.js'/);
  const url = await fetch(`${proxyUrl}/__proxy/url.js`);
  assert.match(await url.text(), /export function rewriteRequestUrl/);
});

test('hook.js에 서비스 워커 등록 코드, 시작 페이지 별칭 /__proxy/', async () => {
  const hook = await (await fetch(`${proxyUrl}/__proxy/hook.js`)).text();
  assert.match(hook, /register\('\/__proxy\/sw\.js', \{ scope: '\/', type: 'module'/);
  const alias = await fetch(`${proxyUrl}/__proxy/`);
  assert.equal(alias.status, 200);
  assert.match(await alias.text(), /<form id="go">/);
});
