// 2단계: 프록시 서버를 거친 HTML/CSS 변환, 문자 인코딩, 헤더 변환 통합 테스트
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createProxyServer } from '../src/server/index.js';

let origin, originUrl, proxy, proxyUrl;
const listen = (server) =>
  new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

// "한국어" 를 EUC-KR 로
const EUC_KR_KOREAN = Buffer.from([0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee]);

before(async () => {
  origin = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    switch (pathname) {
      case '/wiki/Page': {
        const body = gzipSync(`<!doctype html><html><head>
<link rel="stylesheet" href="/static/site.css" integrity="sha384-x">
</head><body><a id="l" href="/wiki/Other">Other</a><img src="//cdn.example.net/a.png"></body></html>`);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-encoding': 'gzip',
          'content-security-policy': "default-src 'self'",
          'x-frame-options': 'DENY',
          'strict-transport-security': 'max-age=31536000',
        });
        return res.end(body);
      }
      case '/static/site.css':
        res.writeHead(200, { 'content-type': 'text/css' });
        return res.end('body{background:url(../img/bg.png)}');
      case '/euckr':
        res.writeHead(200, { 'content-type': 'text/html; charset=euc-kr' });
        return res.end(Buffer.concat([
          Buffer.from('<html><head><meta charset="euc-kr"></head><body><p>'),
          EUC_KR_KOREAN,
          Buffer.from('</p><form action="/search"></form></body></html>'),
        ]));
      case '/euckr-meta-only':
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(Buffer.concat([
          Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=euc-kr"></head><body>'),
          EUC_KR_KOREAN,
          Buffer.from('</body></html>'),
        ]));
      case '/echo-headers':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(req.headers));
      case '/binary':
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]));
      case '/partial':
        res.writeHead(206, { 'content-type': 'text/html', 'content-range': 'bytes 0-9/100' });
        return res.end('<a href="/');
      default:
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<a href="/home">home</a>');
    }
  });
  originUrl = await listen(origin);
  proxy = createProxyServer();
  proxyUrl = await listen(proxy);
});

after(() => {
  proxy.closeAllConnections();
  origin.closeAllConnections();
  proxy.close();
  origin.close();
});

const via = (path, init) => fetch(`${proxyUrl}/p/${originUrl}${path}`, { redirect: 'manual', ...init });

test('HTML: gzip 해제 후 링크/이미지/CSS 링크 변환, hook 삽입, 보안 헤더 제거', async () => {
  const res = await via('/wiki/Page');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('content-security-policy'), null);
  assert.equal(res.headers.get('x-frame-options'), null);
  assert.equal(res.headers.get('strict-transport-security'), null);
  const html = await res.text();
  assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(html));
  assert.match(html, new RegExp(`href="/p/${originUrl}/wiki/Other"`));
  // 원본이 http:// 이므로 프로토콜 상대 URL도 http://
  assert.match(html, /src="\/p\/http:\/\/cdn\.example\.net\/a\.png"/);
  assert.match(html, new RegExp(`<link rel="stylesheet" href="/p/${originUrl}/static/site.css">`));
  assert.match(html, /<head><script src="\/__proxy\/hook\.js" data-proxy-cookie=""><\/script>/);
});

test('CSS: url()을 CSS 파일 기준으로 변환', async () => {
  const res = await via('/static/site.css');
  assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(await res.text(), `body{background:url("/p/${originUrl}/img/bg.png")}`);
});

test('EUC-KR(헤더): UTF-8로 변환해 전달, form은 원래 인코딩으로 전송', async () => {
  const res = await via('/euckr');
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  const html = await res.text();
  assert.match(html, /<p>한국어<\/p>/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /accept-charset="euc-kr"/);
});

test('EUC-KR(meta만): 문서 안 선언으로 인코딩 판단', async () => {
  const html = await (await via('/euckr-meta-only')).text();
  assert.match(html, /한국어/);
});

test('HTML이 아닌 응답은 바이트 그대로', async () => {
  const buf = Buffer.from(await (await via('/binary')).arrayBuffer());
  assert.deepEqual([...buf], [0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
});

test('206 부분 응답은 변환하지 않음', async () => {
  const res = await via('/partial');
  assert.equal(res.status, 206);
  assert.equal(await res.text(), '<a href="/');
});

test('에러 상태의 HTML도 변환', async () => {
  const res = await via('/nope');
  assert.equal(res.status, 404);
  assert.match(await res.text(), new RegExp(`href="/p/${originUrl}/home"`));
});

test('요청 헤더: Referer/Origin을 원본 기준으로, 쿠키/프록시 헤더 제거', async () => {
  const h = await (await via('/echo-headers', {
    method: 'POST',
    body: 'x',
    headers: {
      referer: `${proxyUrl}/p/https://www.example.com/app`,
      origin: proxyUrl,
      cookie: 'local=1',
      'x-forwarded-for': '1.2.3.4',
    },
  })).json();
  assert.equal(h.host, new URL(originUrl).host);
  assert.equal(h.referer, 'https://www.example.com/app');
  assert.equal(h.origin, 'https://www.example.com');
  assert.equal(h.cookie, undefined);
  assert.equal(h['x-forwarded-for'], undefined);
});
