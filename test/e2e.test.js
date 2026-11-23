// 7단계 통합 테스트: 로컬 테스트 사이트 + 프록시 서버를 띄워 전체 흐름을 검증한다.
//
//  A. HTTP 수준 (항상 실행): 쿠키, 리다이렉트, Range/206, 에러 처리, WebSocket 중계, 세션 API
//  B. 실제 브라우저 (Playwright가 설치되어 있을 때만): 동적 fetch, location 이동, 페이지 JS의 WebSocket, 미디어 탐색
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { WebSocket, WebSocketServer } from 'ws';
import { createProxyServer } from '../src/server/index.js';
import { SESSION_COOKIE } from '../src/server/cookies.js';

// ---------------------------------------------------------------------------
// 테스트 사이트
// ---------------------------------------------------------------------------

/** 8kHz 16bit 모노 WAV (사인파) */
function makeWav(seconds, rate = 8000) {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const MEDIA = makeWav(600); // 약 9.6MB: 브라우저가 한 번에 다 받지 않고 Range로 탐색하도록

function createSite(name) {
  const log = { ranges: [], wsHeaders: [], wsClose: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const html = (body, extra = {}) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra });
      res.end(`<!doctype html><html><head><title>${name}</title></head><body>${body}</body></html>`);
    };
    const json = (data, extra = {}) => {
      res.writeHead(200, { 'content-type': 'application/json', ...extra });
      res.end(JSON.stringify(data));
    };
    switch (u.pathname) {
      case '/login': {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const user = new URLSearchParams(body).get('user') ?? 'anon';
          res.writeHead(302, { location: '/me', 'set-cookie': [`session=${name}-${user}; Path=/; HttpOnly`, `ui=${name}; Path=/`] });
          res.end();
        });
        return;
      }
      case '/me':
        return json({ site: name, cookie: req.headers.cookie ?? '' });
      case '/hop1':
        res.writeHead(301, { location: '/hop2' });
        return res.end();
      case '/hop2':
        res.writeHead(302, { location: u.searchParams.get('to') ?? '/me' });
        return res.end();
      case '/server-error':
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('origin exploded');
      case '/media.wav': {
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        log.ranges.push(req.headers.range ?? null);
        if (!m) {
          res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': MEDIA.length, 'accept-ranges': 'bytes' });
          return res.end(req.method === 'HEAD' ? undefined : MEDIA);
        }
        const start = m[1] === '' ? MEDIA.length - Number(m[2]) : Number(m[1]);
        const end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), MEDIA.length - 1) : MEDIA.length - 1;
        res.writeHead(206, {
          'content-type': 'audio/wav',
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${MEDIA.length}`,
          'accept-ranges': 'bytes',
        });
        return res.end(MEDIA.subarray(start, end + 1));
      }
      case '/app':
        // 동적 fetch, location 이동, WebSocket, 미디어를 쓰는 페이지 (브라우저 테스트용)
        return html(`
<p id="fetched"></p><p id="ws"></p>
<audio id="media" preload="metadata" src="/media.wav"></audio>
<button id="go" onclick="location.href = '/next?from=' + encodeURIComponent(location.pathname)">go</button>
<script>
  fetch('/api/data').then((r) => r.json()).then((d) => { document.getElementById('fetched').textContent = d.value; });
  const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/echo', ['chat.v2']);
  sock.onopen = () => sock.send('hello from ' + location.host);
  sock.onmessage = (e) => { document.getElementById('ws').textContent = e.data + ' | ' + sock.protocol; sock.close(); };
</script>`);
      case '/api/data':
        return json({ value: `data-from-${name}` });
      case '/api/echo-body': {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => json({ method: req.method, type: req.headers['content-type'] ?? null, body }));
        return;
      }
      case '/request-object':
        // fetch(new Request(url, { method: 'POST', body })) 형태 (유튜브 등 큰 사이트의 네트워크 라이브러리가 씀)
        return html(`<p id="out"></p><script>
  fetch(new Request('/api/echo-body', { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } }))
    .then((r) => r.text())
    .then((t) => { document.getElementById('out').textContent = t; })
    .catch((e) => { document.getElementById('out').textContent = 'ERROR ' + e; });
</script>`);
      case '/next':
        return html(`<p id="where">${name}:${u.pathname}${u.search}</p>`);
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
    }
  });

  // WebSocket 서버: /echo 에코, /forbidden 거부
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('chat.v2') ? 'chat.v2' : false),
  });
  wss.on('headers', (headers) => headers.push(`Set-Cookie: ws_${name}=1; Path=/`));
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/forbidden') {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (pathname !== '/echo') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      log.wsHeaders.push({ origin: req.headers.origin, cookie: req.headers.cookie ?? '', host: req.headers.host });
      ws.on('message', (data, isBinary) => {
        if (!isBinary && data.toString() === 'close-me') return ws.close(4001, 'server says bye');
        ws.send(data, { binary: isBinary });
      });
      ws.on('close', (code, reason) => log.wsClose.push({ code, reason: reason.toString() }));
    });
  });
  return { server, log };
}

// ---------------------------------------------------------------------------

let A, B, siteA, siteB, proxy, proxyUrl, proxyPort;

const listen = (server, host) =>
  new Promise((r) => server.listen(0, host, () => r(server.address().port)));

before(async () => {
  siteA = createSite('A');
  siteB = createSite('B');
  // 호스트 이름이 다르면 쿠키 입장에서 다른 사이트
  A = `http://127.0.0.1:${await listen(siteA.server, '127.0.0.1')}`;
  B = `http://localhost:${await listen(siteB.server, 'localhost')}`;
  proxy = createProxyServer({ timeoutMs: 3000 });
  proxyPort = await listen(proxy, '127.0.0.1');
  proxyUrl = `http://127.0.0.1:${proxyPort}`;
});

after(() => {
  for (const s of [proxy, siteA.server, siteB.server]) {
    s.closeAllConnections();
    s.close();
  }
});

/** 브라우저 하나: __proxy_sid 를 기억하고, 원하면 리다이렉트를 따라간다 */
function client() {
  let sid = null;
  const cookieHeader = () => (sid ? { cookie: `${SESSION_COOKIE}=${sid}` } : {});
  async function request(path, { follow = true, ...init } = {}) {
    const hops = [];
    for (let i = 0; i < 10; i++) {
      const res = await fetch(proxyUrl + path, { redirect: 'manual', ...init, headers: { ...init.headers, ...cookieHeader() } });
      for (const sc of res.headers.getSetCookie()) {
        const m = new RegExp(`^${SESSION_COOKIE}=([^;]+)`).exec(sc);
        if (m) sid = m[1];
      }
      const loc = res.headers.get('location');
      if (!follow || res.status < 300 || res.status >= 400 || !loc) return Object.assign(res, { hops });
      hops.push({ status: res.status, location: loc });
      path = loc;
      // 302/303은 GET으로 (브라우저 동작)
      if (res.status === 302 || res.status === 303) init = { ...init, method: 'GET', body: undefined };
    }
    throw new Error('too many redirects');
  }
  function ws(target, { protocols, origin = 'https://page.example' } = {}) {
    const url = `ws://127.0.0.1:${proxyPort}/__proxy/ws?url=${encodeURIComponent(target)}${origin ? `&origin=${encodeURIComponent(origin)}` : ''}`;
    return new WebSocket(url, protocols, { headers: cookieHeader() });
  }
  return { request, ws, get sid() { return sid; } };
}

const wsOpen = (ws) => new Promise((resolve, reject) => {
  ws.once('open', () => resolve(ws));
  ws.once('error', reject);
  ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, headers: res.headers })));
});
const nextMessage = (ws) => new Promise((r) => ws.once('message', (data, isBinary) => r({ data, isBinary })));
const closed = (ws) => new Promise((r) => ws.once('close', (code, reason) => r({ code, reason: reason.toString() })));

// ===========================================================================
describe('A. HTTP 수준', () => {
  test('쿠키: 로그인 POST -> 302 -> /me 에 쿠키 유지, 사이트별 분리', async () => {
    const c = client();
    const me = await c.request(`/p/${A}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=kim' });
    assert.deepEqual(me.hops, [{ status: 302, location: `/p/${A}/me` }]);
    assert.deepEqual(await me.json(), { site: 'A', cookie: 'session=A-kim; ui=A' });
    await c.request(`/p/${B}/login`, { method: 'POST', body: 'user=lee', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal((await (await c.request(`/p/${A}/me`)).json()).cookie, 'session=A-kim; ui=A');
    assert.equal((await (await c.request(`/p/${B}/me`)).json()).cookie, 'session=B-lee; ui=B');
    // 다른 브라우저(세션)에는 없음
    assert.equal((await (await client().request(`/p/${A}/me`)).json()).cookie, '');
  });

  test('리다이렉트: 상대/절대(다른 사이트) Location 모두 프록시 경로, 끝까지 프록시 안', async () => {
    const res = await client().request(`/p/${A}/hop1?x=1`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.hops, [
      { status: 301, location: `/p/${A}/hop2` },
      { status: 302, location: `/p/${A}/me` },
    ]);
    const cross = await client().request(`/p/${A}/hop2?to=${encodeURIComponent(`${B}/me`)}`);
    assert.deepEqual(cross.hops, [{ status: 302, location: `/p/${B}/me` }]);
    assert.equal((await cross.json()).site, 'B');
  });

  test('Range: 206 과 Content-Range/Length 그대로, 바이트 정확, 열린 범위/접미사 범위', async () => {
    const c = client();
    const part = await c.request(`/p/${A}/media.wav`, { headers: { range: 'bytes=1000-1999' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 1000-1999/${MEDIA.length}`);
    assert.equal(part.headers.get('content-length'), '1000');
    assert.equal(part.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), MEDIA.subarray(1000, 2000));

    const tail = await c.request(`/p/${A}/media.wav`, { headers: { range: `bytes=${MEDIA.length - 10}-` } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), MEDIA.subarray(MEDIA.length - 10));
    const suffix = await c.request(`/p/${A}/media.wav`, { headers: { range: 'bytes=-5' } });
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), MEDIA.subarray(MEDIA.length - 5));
    // 원본으로 Range 헤더가 그대로 전달됨
    assert.ok(siteA.log.ranges.includes('bytes=1000-1999'));
  });

  test('대용량: 전체 응답과 HEAD 응답의 Content-Length 유지', async () => {
    const c = client();
    const head = await c.request(`/p/${A}/media.wav`, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), String(MEDIA.length));
    const full = await c.request(`/p/${A}/media.wav`);
    assert.equal(full.headers.get('content-length'), String(MEDIA.length));
    assert.equal(Buffer.from(await full.arrayBuffer()).length, MEDIA.length);
  });

  test('에러: 원본의 에러는 상태코드 그대로, 프록시 자체 에러는 에러 페이지(x-proxy-error)', async () => {
    const c = client();
    const origin500 = await c.request(`/p/${A}/server-error`);
    assert.equal(origin500.status, 500);
    assert.equal(origin500.headers.get('x-proxy-error'), null);
    assert.equal(await origin500.text(), 'origin exploded');
    const origin404 = await c.request(`/p/${A}/nope`);
    assert.equal(origin404.status, 404);
    assert.equal(origin404.headers.get('x-proxy-error'), null);

    const bad = await c.request('/p/not-a-url');
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('x-proxy-error'), '1');
    const down = await c.request('/p/http://127.0.0.1:9/');
    assert.equal(down.status, 502);
    assert.equal(down.headers.get('x-proxy-error'), '1');
    assert.match(await down.text(), /연결 실패/);
  });

  test('WebSocket: 텍스트/바이너리 에코, 서브프로토콜, Origin 은 페이지 원본 기준', async () => {
    const c = client();
    await c.request(`/p/${A}/me`); // 세션 생성
    const ws = await wsOpen(c.ws(`${A.replace('http', 'ws')}/echo`, { protocols: ['chat.v2', 'chat.v1'], origin: 'https://page.example' }));
    assert.equal(ws.protocol, 'chat.v2');

    ws.send('안녕 hello');
    const text = await nextMessage(ws);
    assert.equal(text.isBinary, false);
    assert.equal(text.data.toString(), '안녕 hello');

    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    ws.send(bytes);
    const bin = await nextMessage(ws);
    assert.equal(bin.isBinary, true);
    assert.deepEqual(Buffer.from(bin.data), bytes);

    // 큰 메시지
    const big = Buffer.alloc(1024 * 1024, 7);
    ws.send(big);
    assert.equal((await nextMessage(ws)).data.length, big.length);

    const headers = siteA.log.wsHeaders.at(-1);
    assert.equal(headers.origin, 'https://page.example');
    assert.equal(headers.host, new URL(A).host);
    ws.close();
  });

  test('WebSocket: 쿠키 전송(3단계 규칙)과 핸드셰이크 Set-Cookie 저장', async () => {
    const c = client();
    await c.request(`/p/${A}/login`, { method: 'POST', body: 'user=ws', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const ws = await wsOpen(c.ws(`${A.replace('http', 'ws')}/echo`));
    assert.equal(siteA.log.wsHeaders.at(-1).cookie, 'session=A-ws; ui=A');
    ws.close();
    await closed(ws);
    // 핸드셰이크 응답의 Set-Cookie(ws_A=1)가 저장되어 이후 HTTP 요청에도 실림
    assert.equal((await (await c.request(`/p/${A}/me`)).json()).cookie, 'session=A-ws; ui=A; ws_A=1');
    // origin 을 안 보내면 대상 서버와 같은 origin
    const ws2 = await wsOpen(c.ws(`${A.replace('http', 'ws')}/echo`, { origin: null }));
    assert.equal(siteA.log.wsHeaders.at(-1).origin, A);
    ws2.close();
  });

  test('WebSocket: 한쪽이 닫으면 다른 쪽도 닫힘 (종료 코드 전달)', async () => {
    const c = client();
    const ws1 = await wsOpen(c.ws(`${A.replace('http', 'ws')}/echo`));
    const done1 = closed(ws1);
    ws1.close(4000, 'client bye');
    await done1;
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(siteA.log.wsClose.at(-1), { code: 4000, reason: 'client bye' });

    const ws2 = await wsOpen(c.ws(`${A.replace('http', 'ws')}/echo`));
    const done2 = closed(ws2);
    ws2.send('close-me');
    assert.deepEqual(await done2, { code: 4001, reason: 'server says bye' });
  });

  test('WebSocket: 원본 거부는 상태코드 그대로, 연결 실패/잘못된 URL/알 수 없는 경로는 프록시 에러', async () => {
    const c = client();
    await assert.rejects(wsOpen(c.ws(`${A.replace('http', 'ws')}/forbidden`)), (e) => e.status === 403);
    await assert.rejects(wsOpen(c.ws('ws://127.0.0.1:9/')), (e) => e.status === 502 && e.headers['x-proxy-error'] === '1');
    await assert.rejects(wsOpen(new WebSocket(`ws://127.0.0.1:${proxyPort}/__proxy/ws?url=${encodeURIComponent('https://x.com')}`)), (e) => e.status === 400);
    await assert.rejects(wsOpen(new WebSocket(`ws://127.0.0.1:${proxyPort}/somewhere`)), (e) => e.status === 404);
    // 프록시 서버는 계속 동작
    assert.equal((await c.request(`/p/${A}/me`)).status, 200);
  });

  test('세션 API: 사이트별 쿠키 수, 쿠키 초기화', async () => {
    const c = client();
    const none = await (await fetch(`${proxyUrl}/__proxy/session`)).json();
    assert.deepEqual(none, { active: false, id: null, cookies: 0, sites: [] });

    await c.request(`/p/${A}/login`, { method: 'POST', body: 'user=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    await c.request(`/p/${B}/login`, { method: 'POST', body: 'user=y', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const info = await (await c.request('/__proxy/session')).json();
    assert.equal(info.active, true);
    assert.equal(info.id, `${c.sid.slice(0, 8)}…`);
    assert.equal(info.cookies, 4);
    assert.deepEqual(info.sites.map((s) => [s.domain, s.count, s.httpOnly]).sort(), [['127.0.0.1', 2, 1], ['localhost', 2, 1]]);

    const reset = await (await c.request('/__proxy/session/reset', { method: 'POST' })).json();
    assert.deepEqual(reset, { ok: true, cleared: 4 });
    assert.equal((await (await c.request(`/p/${A}/me`)).json()).cookie, '');
    assert.equal((await c.request('/__proxy/session/reset')).status, 405);
  });

  test('시작 페이지에 세션 정보와 쿠키 초기화 버튼', async () => {
    const html = await (await fetch(`${proxyUrl}/`)).text();
    assert.match(html, /id="reset"[^>]*>쿠키 초기화</);
    assert.match(html, /\/__proxy\/session/);
  });
});

// ===========================================================================
// B. 실제 브라우저 (Playwright가 있으면)
let chromium = null;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  // 설치되어 있지 않으면 건너뜀
}

describe('B. 브라우저 (Playwright)', { skip: chromium ? false : 'playwright 가 설치되어 있지 않아 건너뜀 (npm i -D playwright && npx playwright install chromium)' }, () => {
  let browser;
  let page;
  let browserProxy;
  let browserProxyUrl;

  before(async () => {
    // 서비스 워커는 같은 origin(localhost)에서만 등록되므로 localhost 로 띄운다
    browserProxy = createProxyServer();
    browserProxyUrl = `http://localhost:${await listen(browserProxy, '127.0.0.1')}`;
    browser = await chromium.launch();
    page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(`${browserProxyUrl}/p/${A}/app`);
    // 첫 방문: hook 이 서비스 워커를 등록하고 한 번 새로고침한다
    await page.waitForFunction(() => navigator.serviceWorker.controller && document.getElementById('fetched')?.textContent);
  });

  after(async () => {
    await browser?.close();
    browserProxy?.closeAllConnections();
    browserProxy?.close();
  });

  test('동적 fetch("/api/data") 가 프록시를 거쳐 원본 사이트에서 옴', async () => {
    assert.equal(await page.textContent('#fetched'), 'data-from-A');
  });

  test('페이지 JS의 WebSocket 에코 (hook 이 /__proxy/ws 로 변환)', async () => {
    await page.waitForFunction(() => document.getElementById('ws').textContent);
    assert.equal(await page.textContent('#ws'), `hello from ${new URL(A).host} | chat.v2`);
  });

  test('미디어 탐색(seek): Range 요청으로 중간 위치부터 받아 재생 위치 이동', async () => {
    siteA.log.ranges.length = 0;
    const result = await page.evaluate(() => new Promise((resolve) => {
      const media = document.getElementById('media');
      const seek = () => {
        media.addEventListener('seeked', () => resolve({ time: media.currentTime, duration: media.duration }), { once: true });
        media.currentTime = 500;
      };
      if (media.readyState >= 1) seek();
      else media.addEventListener('loadedmetadata', seek, { once: true });
    }));
    assert.equal(result.duration, 600);
    assert.equal(result.time, 500);
    // 파일 중간부터 요청하는 Range 가 원본까지 전달됨
    assert.ok(siteA.log.ranges.some((r) => r && /^bytes=[1-9]\d*-/.test(r)), JSON.stringify(siteA.log.ranges));
  });

  test('fetch(Request 객체) 의 POST 바디가 HTTP/1.1 연결에서도 전송됨', async () => {
    await page.goto(`${browserProxyUrl}/p/${A}/request-object`);
    await page.waitForFunction(() => document.getElementById('out').textContent);
    assert.equal(await page.textContent('#out'), JSON.stringify({ method: 'POST', type: 'application/json', body: '{"a":1}' }));
    await page.goto(`${browserProxyUrl}/p/${A}/app`);
    await page.waitForFunction(() => document.getElementById('fetched')?.textContent);
  });

  test('location.href = "/next..." 이동이 프록시 안에서 일어남', async () => {
    const navigations = [];
    page.on('request', (r) => r.isNavigationRequest() && navigations.push(r.url()));
    await Promise.all([page.waitForURL(/\/next/), page.click('#go')]);
    assert.equal(await page.textContent('#where'), 'A:/next?from=%2Fapp');
    // 서비스 워커가 고친 것이 아니라 처음부터 프록시 URL로 이동 (AST 변환)
    assert.equal(navigations[0], `${browserProxyUrl}/p/${A}/next?from=%2Fapp`);
  });
});
