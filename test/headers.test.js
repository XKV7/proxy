import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestHeaders, buildResponseHeaders } from '../src/server/headers.js';
import { decodeBody, detectCharset } from '../src/server/charset.js';
import { proxifyRefresh, proxify } from '../src/shared/url.js';

const TARGET = 'https://api.example.com/v1/data';

test('요청: Host/쿠키/프록시/hop-by-hop 헤더 제거, 나머지 유지', () => {
  const h = buildRequestHeaders({
    host: 'localhost:8080',
    connection: 'keep-alive',
    cookie: 'local=1',
    'proxy-authorization': 'x',
    'proxy-connection': 'keep-alive',
    'x-forwarded-for': '1.2.3.4',
    forwarded: 'for=1.2.3.4',
    via: '1.1 proxy',
    'accept-encoding': 'gzip, br, zstd',
    accept: 'text/html',
    'user-agent': 'UA',
    'content-type': 'application/json',
    'content-length': '10',
    range: 'bytes=0-',
  }, TARGET);
  assert.deepEqual(h, {
    accept: 'text/html',
    'user-agent': 'UA',
    'content-type': 'application/json',
    'content-length': '10',
    range: 'bytes=0-',
  });
});

test('요청: Referer를 원본 URL로', () => {
  const h = buildRequestHeaders({ referer: 'http://localhost:8080/p/https://www.example.com/page?q=1' }, TARGET);
  assert.equal(h.referer, 'https://www.example.com/page?q=1');
});

test('요청: 프록시 경로가 아닌 Referer(시작 페이지 등)는 보내지 않음', () => {
  assert.equal(buildRequestHeaders({ referer: 'http://localhost:8080/' }, TARGET).referer, undefined);
  assert.equal(buildRequestHeaders({ referer: 'garbage' }, TARGET).referer, undefined);
});

test('요청: Origin은 요청한 페이지(Referer)의 원본 origin', () => {
  const h = buildRequestHeaders({
    origin: 'http://localhost:8080',
    referer: 'http://localhost:8080/p/https://www.example.com/app',
  }, TARGET);
  assert.equal(h.origin, 'https://www.example.com');
});

test('요청: Referer가 없으면 Origin은 대상 origin, "null"은 유지, 원래 없으면 추가 안 함', () => {
  assert.equal(buildRequestHeaders({ origin: 'http://localhost:8080' }, TARGET).origin, 'https://api.example.com');
  assert.equal(buildRequestHeaders({ origin: 'null' }, TARGET).origin, 'null');
  assert.equal(buildRequestHeaders({}, TARGET).origin, undefined);
});

test('응답: 보안 정책 헤더와 압축/쿠키 헤더 제거', () => {
  const h = buildResponseHeaders(new Headers({
    'content-type': 'text/html',
    'content-security-policy': "default-src 'self'",
    'content-security-policy-report-only': "default-src 'self'",
    'x-frame-options': 'DENY',
    'strict-transport-security': 'max-age=1',
    'content-encoding': 'gzip',
    'content-length': '100',
    'set-cookie': 'a=1',
    'cache-control': 'max-age=60',
  }), TARGET);
  assert.deepEqual(h, { 'content-type': 'text/html', 'cache-control': 'max-age=60' });
});

test('응답: Location / Refresh / Link 를 프록시 경로로', () => {
  const h = buildResponseHeaders(new Headers({
    location: '/login?next=%2F',
    refresh: '3; url=//other.com/x',
    link: '<https://cdn.example.net/a.css>; rel=preload; as=style, </b.js>; rel=preload; as=script',
  }), TARGET);
  assert.equal(h.location, '/p/https://api.example.com/login?next=%2F');
  assert.equal(h.refresh, '3; url=/p/https://other.com/x');
  assert.equal(h.link, '</p/https://cdn.example.net/a.css>; rel=preload; as=style, </p/https://api.example.com/b.js>; rel=preload; as=script');
});

test('proxify / proxifyRefresh 경계값', () => {
  assert.equal(proxify('  /a  ', TARGET), '/p/https://api.example.com/a');
  assert.equal(proxify('blob:https://x/1', TARGET), 'blob:https://x/1');
  assert.equal(proxify('about:blank', TARGET), 'about:blank');
  assert.equal(proxifyRefresh('0', TARGET), '0');
  assert.equal(proxifyRefresh('0; /next', TARGET), '0; /p/https://api.example.com/next');
});

// ---------- charset ----------

const eucKr = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]); // "한글" (EUC-KR)

test('charset: Content-Type 헤더 우선 (레이블 정규화)', () => {
  assert.equal(detectCharset(eucKr, 'text/html; charset=EUC-KR', 'html'), 'euc-kr');
  assert.equal(detectCharset(eucKr, 'text/html; charset="ks_c_5601-1987"', 'html'), 'euc-kr');
  assert.deepEqual(decodeBody(eucKr, 'text/plain; charset=euc-kr', 'html'), { text: '한글', charset: 'euc-kr' });
});

test('charset: 헤더가 없으면 HTML <meta>', () => {
  const html = Buffer.concat([Buffer.from('<html><head><meta charset="euc-kr"></head><body>'), eucKr]);
  assert.equal(decodeBody(html, 'text/html', 'html').text.endsWith('한글'), true);
  const equiv = Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=euc-kr">');
  assert.equal(detectCharset(equiv, null, 'html'), 'euc-kr');
});

test('charset: 모르는 레이블은 무시하고 다음 단계로', () => {
  assert.equal(detectCharset(Buffer.from('<meta charset="euc-kr">'), 'text/html; charset=bogus', 'html'), 'euc-kr');
});

test('charset: CSS @charset', () => {
  const css = Buffer.concat([Buffer.from('@charset "euc-kr";\na{content:"'), eucKr, Buffer.from('"}')]);
  assert.match(decodeBody(css, 'text/css', 'css').text, /한글/);
});

test('charset: BOM이 헤더보다 우선', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('한글')]);
  assert.deepEqual(decodeBody(buf, 'text/html; charset=euc-kr', 'html'), { text: '한글', charset: 'utf-8' });
});

test('charset: 선언이 없으면 UTF-8, UTF-8이 아니면 windows-1252', () => {
  assert.equal(detectCharset(Buffer.from('<p>한글</p>'), 'text/html', 'html'), 'utf-8');
  assert.equal(detectCharset(Buffer.from([0x3c, 0x70, 0x3e, 0xe9]), 'text/html', 'html'), 'windows-1252');
});
