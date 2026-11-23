import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROXY_PREFIX, encodeProxyUrl, decodeProxyUrl, resolve,
  proxifyClientUrl, encodeWsProxyUrl, decodeWsProxyUrl, rewriteAttribute, isUrlAttribute,
} from '../src/shared/url.js';

const SAMPLES = [
  'https://example.com/',
  'http://example.com/a/b?x=1',
  'https://example.com/a/b?x=1&y=%ED%95%9C#frag',
  'https://sub.example.com:8443/path/to/file.png',
  'https://example.com/%20space?q=a%2Fb',
  'https://user:pw@example.com/',
  'https://xn--3e0b707e.com/',
];

test('encodeProxyUrl: /p/ 접두사 + 원본 URL', () => {
  assert.equal(encodeProxyUrl('https://example.com/a/b?x=1'), '/p/https://example.com/a/b?x=1');
  assert.equal(encodeProxyUrl('https://example.com'), '/p/https://example.com/');
  assert.ok(encodeProxyUrl('https://example.com').startsWith(PROXY_PREFIX));
});

test('encodeProxyUrl: 잘못된 URL / http(s) 이외는 거부', () => {
  assert.throws(() => encodeProxyUrl('not a url'), TypeError);
  assert.throws(() => encodeProxyUrl('/relative/path'), TypeError);
  assert.throws(() => encodeProxyUrl('javascript:alert(1)'), TypeError);
  assert.throws(() => encodeProxyUrl('file:///etc/passwd'), TypeError);
  assert.throws(() => encodeProxyUrl('ftp://example.com/'), TypeError);
});

test('decodeProxyUrl: 기본 동작', () => {
  assert.equal(decodeProxyUrl('/p/https://example.com/a/b?x=1'), 'https://example.com/a/b?x=1');
  assert.equal(decodeProxyUrl('/p/https://example.com'), 'https://example.com/');
});

test('decodeProxyUrl: 합쳐진 슬래시(https:/host) 복원', () => {
  assert.equal(decodeProxyUrl('/p/https:/example.com/a'), 'https://example.com/a');
  assert.equal(decodeProxyUrl('/p/http:/example.com/'), 'http://example.com/');
});

test('decodeProxyUrl: 규칙에 맞지 않으면 null', () => {
  assert.equal(decodeProxyUrl('/x/https://example.com/'), null);
  assert.equal(decodeProxyUrl('/p/'), null);
  assert.equal(decodeProxyUrl('/p/not-a-url'), null);
  assert.equal(decodeProxyUrl('/p/javascript:alert(1)'), null);
  assert.equal(decodeProxyUrl('/p/file:///etc/passwd'), null);
  assert.equal(decodeProxyUrl(undefined), null);
});

test('encode -> decode 왕복', () => {
  for (const url of SAMPLES) {
    const expected = new URL(url).href;
    assert.equal(decodeProxyUrl(encodeProxyUrl(url)), expected, url);
  }
});

test('decode -> encode 왕복', () => {
  for (const url of SAMPLES) {
    const path = encodeProxyUrl(url);
    assert.equal(encodeProxyUrl(decodeProxyUrl(path)), path, url);
  }
});

test('resolve: 상대 경로 절대화', () => {
  const base = 'https://example.com/a/b/page.html?q=1';
  assert.equal(resolve('img.png', base), 'https://example.com/a/b/img.png');
  assert.equal(resolve('./img.png', base), 'https://example.com/a/b/img.png');
  assert.equal(resolve('../c.css', base), 'https://example.com/a/c.css');
  assert.equal(resolve('/root.js', base), 'https://example.com/root.js');
  assert.equal(resolve('?x=2', base), 'https://example.com/a/b/page.html?x=2');
  assert.equal(resolve('#top', base), 'https://example.com/a/b/page.html?q=1#top');
  assert.equal(resolve('//cdn.example.net/x.js', base), 'https://cdn.example.net/x.js');
  assert.equal(resolve('http://other.com/', base), 'http://other.com/');
});

test('resolve: 해석 불가능하면 null', () => {
  assert.equal(resolve('img.png', 'not-a-base'), null);
});

test('resolve + encode + decode 왕복', () => {
  const base = 'https://example.com/dir/index.html';
  for (const rel of ['a.png', '../b?x=1', '/c/d', '//cdn.example.net/e.js']) {
    const abs = resolve(rel, base);
    assert.equal(decodeProxyUrl(encodeProxyUrl(abs)), abs, rel);
  }
});

// ---------- 5단계: 브라우저(hook.js)용 변환 ----------

const P = 'http://localhost:8080';
const B = 'https://www.example.com/dir/page';

test('proxifyClientUrl: 원본 URL은 변환, 이미 프록시된 URL은 그대로', () => {
  assert.equal(proxifyClientUrl('a.png', B, P), '/p/https://www.example.com/dir/a.png');
  assert.equal(proxifyClientUrl('/api', B, P), '/p/https://www.example.com/api');
  assert.equal(proxifyClientUrl('//cdn.x.com/a', B, P), '/p/https://cdn.x.com/a');
  assert.equal(proxifyClientUrl(new URL('https://o.com/u'), B, P), '/p/https://o.com/u');
  // 이미 프록시 경로
  assert.equal(proxifyClientUrl('/p/https://a.com/x', B, P), '/p/https://a.com/x');
  assert.equal(proxifyClientUrl(`${P}/p/https://a.com/x#h`, B, P), `${P}/p/https://a.com/x#h`);
  assert.equal(proxifyClientUrl('/__proxy/cookies', B, P), '/__proxy/cookies');
  // 프록시 origin 기준으로 해석돼 버린 루트 상대 URL -> 원본 사이트 경로
  assert.equal(proxifyClientUrl(`${P}/api/x?y=1`, B, P), '/p/https://www.example.com/api/x?y=1');
  // /p/ 로 시작하지만 프록시 경로가 아닌 원본 사이트 경로
  assert.equal(proxifyClientUrl('/p/123', B, P), '/p/https://www.example.com/p/123');
  // 대상 아님
  for (const v of ['#a', '', 'javascript:x', 'data:,1', 'blob:https://a/1']) assert.equal(proxifyClientUrl(v, B, P), v);
});

test('encodeWsProxyUrl / decodeWsProxyUrl 왕복', () => {
  const enc = encodeWsProxyUrl('wss://chat.example.com/s?a=1#h', B, P);
  assert.equal(enc, `ws://localhost:8080/__proxy/ws?url=${encodeURIComponent('wss://chat.example.com/s?a=1')}`);
  assert.equal(decodeWsProxyUrl(new URL(enc).pathname + new URL(enc).search), 'wss://chat.example.com/s?a=1');
  assert.equal(encodeWsProxyUrl('/live', B, P), `ws://localhost:8080/__proxy/ws?url=${encodeURIComponent('wss://www.example.com/live')}`);
  assert.equal(encodeWsProxyUrl('http://a.com/x', B, P), `ws://localhost:8080/__proxy/ws?url=${encodeURIComponent('ws://a.com/x')}`);
  assert.match(encodeWsProxyUrl('wss://a.com/', B, 'https://proxy.test'), /^wss:\/\/proxy\.test\/__proxy\/ws\?url=/);
  assert.equal(encodeWsProxyUrl('ftp://a.com/', B, P), null);
  assert.equal(decodeWsProxyUrl('/__proxy/ws?url=https%3A%2F%2Fa.com'), null);
  assert.equal(decodeWsProxyUrl('/__proxy/other?url=ws%3A%2F%2Fa.com'), null);
  assert.equal(decodeWsProxyUrl('/__proxy/ws'), null);
});

test('rewriteAttribute / isUrlAttribute', () => {
  const conv = (u) => `[${u}]`;
  assert.equal(rewriteAttribute('img', 'src', 'a', conv), '[a]');
  assert.equal(rewriteAttribute('img', 'srcset', 'a 1x, b 2x', conv), '[a] 1x, [b] 2x');
  assert.equal(rewriteAttribute('object', 'data', 'm', conv), '[m]');
  assert.equal(rewriteAttribute('div', 'data', 'm', conv), 'm');
  assert.equal(rewriteAttribute('img', 'alt', 'a', conv), 'a');
  assert.equal(isUrlAttribute('a', 'href'), true);
  assert.equal(isUrlAttribute('link', 'imagesrcset'), true);
  assert.equal(isUrlAttribute('div', 'title'), false);
});
