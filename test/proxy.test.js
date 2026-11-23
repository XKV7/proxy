// 로컬 가짜 원본 서버를 띄워 프록시 서버 동작을 검증한다. (외부 네트워크 불필요)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createProxyServer } from '../src/server/index.js';

let origin, originUrl, proxy, proxyUrl;

const listen = (server) =>
  new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

before(async () => {
  origin = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    switch (pathname) {
      case '/hello':
        res.writeHead(200, { 'content-type': 'text/plain', 'x-custom': 'yes' });
        return res.end('hello world');
      case '/gzip': {
        const body = gzipSync('compressed body');
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': body.length });
        return res.end(body);
      }
      case '/echo': {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            method: req.method,
            contentType: req.headers['content-type'] ?? null,
            cookie: req.headers.cookie ?? null,
            body: Buffer.concat(chunks).toString(),
          }));
        });
        return;
      }
      case '/redirect-relative':
        res.writeHead(302, { location: '/hello?from=redirect' });
        return res.end();
      case '/redirect-absolute':
        res.writeHead(301, { location: 'https://example.org/target' });
        return res.end();
      case '/big': {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let n = 0;
        const write = () => {
          while (n < 32) {
            n++;
            if (!res.write(chunk)) return res.once('drain', write);
          }
          res.end();
        };
        return write();
      }
      case '/slow':
        return setTimeout(() => res.end('late'), 2000);
      case '/cookie':
        res.writeHead(200, { 'set-cookie': 'a=1; Path=/' });
        return res.end('ok');
      default:
        res.writeHead(404);
        res.end('nope');
    }
  });
  originUrl = await listen(origin);
  proxy = createProxyServer({ timeoutMs: 300 });
  proxyUrl = await listen(proxy);
});

after(() => {
  proxy.closeAllConnections();
  origin.closeAllConnections();
  proxy.close();
  origin.close();
});

const via = (path, init) => fetch(`${proxyUrl}/p/${originUrl}${path}`, { redirect: 'manual', ...init });

test('시작 페이지와 공유 url.js 제공', async () => {
  const index = await fetch(`${proxyUrl}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /\/__proxy\/url\.js/);
  const js = await fetch(`${proxyUrl}/__proxy/url.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(await js.text(), /export function encodeProxyUrl/);
});

test('GET: 상태/헤더/바디 전달', async () => {
  const res = await via('/hello');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-custom'), 'yes');
  assert.equal(await res.text(), 'hello world');
});

test('원본 404는 그대로 전달', async () => {
  const res = await via('/missing');
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'nope');
});

test('압축 해제 후 content-encoding/content-length 제거', async () => {
  const res = await via('/gzip');
  assert.equal(res.headers.get('content-encoding'), null);
  assert.equal(await res.text(), 'compressed body');
});

test('POST 폼: 메서드와 바디 전달', async () => {
  const res = await via('/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=%ED%99%8D&age=20',
  });
  const echo = await res.json();
  assert.equal(echo.method, 'POST');
  assert.equal(echo.contentType, 'application/x-www-form-urlencoded');
  assert.equal(echo.body, 'name=%ED%99%8D&age=20');
});

test('PUT/DELETE 메서드 전달', async () => {
  assert.equal((await (await via('/echo', { method: 'PUT', body: 'x' })).json()).method, 'PUT');
  assert.equal((await (await via('/echo', { method: 'DELETE' })).json()).method, 'DELETE');
});

test('브라우저(localhost) 쿠키는 원본으로 보내지 않음 / 원본 set-cookie는 브라우저로 안 감', async () => {
  const echo = await (await via('/echo', { headers: { cookie: 'local=secret' } })).json();
  assert.equal(echo.cookie, null);
  const res = await via('/cookie');
  // 브라우저에는 프록시 세션 쿠키만 내려간다 (3단계)
  const setCookies = res.headers.getSetCookie();
  assert.equal(setCookies.length, 1);
  assert.match(setCookies[0], /^__proxy_sid=/);
});

test('리다이렉트: 따라가지 않고 Location을 프록시 경로로 변환', async () => {
  const rel = await via('/redirect-relative');
  assert.equal(rel.status, 302);
  assert.equal(rel.headers.get('location'), `/p/${originUrl}/hello?from=redirect`);

  const abs = await via('/redirect-absolute');
  assert.equal(abs.status, 301);
  assert.equal(abs.headers.get('location'), '/p/https://example.org/target');
});

test('큰 응답 스트리밍', async () => {
  const res = await via('/big');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 32 * 64 * 1024);
});

test('잘못된 URL -> 400 에러 페이지', async () => {
  for (const path of ['/p/not-a-url', '/p/javascript:alert(1)']) {
    const res = await fetch(proxyUrl + path);
    assert.equal(res.status, 400, path);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /잘못된 URL/);
  }
});

test('연결 실패 -> 502 에러 페이지', async () => {
  const closed = http.createServer();
  const url = await listen(closed);
  await new Promise((r) => closed.close(r));
  const res = await fetch(`${proxyUrl}/p/${url}/`);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /연결 실패/);
});

test('타임아웃 -> 504 에러 페이지', async () => {
  const res = await via('/slow');
  assert.equal(res.status, 504);
  assert.match(await res.text(), /시간 초과/);
});

test('없는 경로 -> 404', async () => {
  const res = await fetch(`${proxyUrl}/nothing`);
  assert.equal(res.status, 404);
});
