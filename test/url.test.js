import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROXY_PREFIX, encodeProxyUrl, decodeProxyUrl, resolve } from '../src/shared/url.js';

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
