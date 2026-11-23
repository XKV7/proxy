import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CookieJar, CookieStore, parseSetCookie, parseCookieDate,
  domainMatch, pathMatch, defaultPath, readCookieHeader,
} from '../src/server/cookies.js';

const T0 = Date.UTC(2026, 0, 1);
const names = (jar, url, opts) => jar.getCookies(url, { now: T0, ...opts }).map((c) => c.name);
const str = (jar, url, opts) => jar.getCookieString(url, { now: T0, ...opts });
const set = (jar, header, url, opts) => jar.setCookie(header, url, { now: T0, ...opts });

// ---------- 파싱 ----------

test('parseSetCookie: 이름/값/속성', () => {
  assert.deepEqual(
    parseSetCookie('sid=abc=def; Domain=.Example.COM; Path=/app; Max-Age=60; Secure; HttpOnly; SameSite=Lax'),
    { name: 'sid', value: 'abc=def', domain: 'example.com', path: '/app', maxAge: 60, secure: true, httpOnly: true, sameSite: 'lax' },
  );
});

test('parseSetCookie: 잘못된 형식은 무시, 이상한 속성 값은 속성만 무시', () => {
  assert.equal(parseSetCookie('novalue'), null);
  assert.equal(parseSetCookie('=x'), null);
  const c = parseSetCookie(' a = 1 ; Max-Age=abc; Expires=garbage; Domain=; SameSite=weird; unknown');
  assert.deepEqual(c, { name: 'a', value: '1', secure: false, httpOnly: false });
  // 같은 속성이 여러 번이면 마지막 값
  assert.equal(parseSetCookie('a=1; Path=/x; Path=/y').path, '/y');
});

test('parseCookieDate: 여러 날짜 형식', () => {
  const want = Date.UTC(2015, 9, 21, 7, 28, 0);
  assert.equal(parseCookieDate('Wed, 21 Oct 2015 07:28:00 GMT'), want);
  assert.equal(parseCookieDate('Wednesday, 21-Oct-15 07:28:00 GMT'), want); // RFC 850, 2자리 연도
  assert.equal(parseCookieDate('Wed Oct 21 07:28:00 2015'), want); // asctime
  assert.equal(parseCookieDate('Thu, 01 Jan 1970 00:00:00 GMT'), 0);
  assert.equal(parseCookieDate('01-Jan-69 00:00:00'), Date.UTC(2069, 0, 1));
  assert.equal(parseCookieDate('not a date'), null);
  assert.equal(parseCookieDate('Wed, 30 Feb 2015 07:28:00 GMT'), null);
  assert.equal(parseCookieDate('Wed, 21 Oct 2015 25:28:00 GMT'), null);
});

test('readCookieHeader', () => {
  assert.deepEqual(readCookieHeader('a=1; b = 2;c=x=y; bad'), { a: '1', b: '2', c: 'x=y' });
  assert.deepEqual(readCookieHeader(undefined), {});
});

// ---------- Domain 매칭 ----------

test('domainMatch / pathMatch / defaultPath 기본 규칙', () => {
  assert.equal(domainMatch('sub.example.com', 'example.com'), true);
  assert.equal(domainMatch('example.com', 'example.com'), true);
  assert.equal(domainMatch('badexample.com', 'example.com'), false);
  assert.equal(domainMatch('example.com', 'sub.example.com'), false);
  assert.equal(domainMatch('1.2.3.4', '2.3.4'), false);

  assert.equal(pathMatch('/a', '/a'), true);
  assert.equal(pathMatch('/a/b', '/a'), true);
  assert.equal(pathMatch('/a/b', '/a/'), true);
  assert.equal(pathMatch('/ab', '/a'), false);
  assert.equal(pathMatch('/', '/a'), false);
  assert.equal(pathMatch('/anything', '/'), true);

  assert.equal(defaultPath('/a/b/c'), '/a/b');
  assert.equal(defaultPath('/a/'), '/a');
  assert.equal(defaultPath('/a'), '/');
  assert.equal(defaultPath('/'), '/');
  assert.equal(defaultPath(''), '/');
});

test('Domain=.example.com 은 하위 도메인에도 적용', () => {
  const jar = new CookieJar();
  assert.equal(set(jar, 'a=1; Domain=.example.com', 'https://www.example.com/'), true);
  assert.deepEqual(names(jar, 'https://example.com/'), ['a']);
  assert.deepEqual(names(jar, 'https://www.example.com/'), ['a']);
  assert.deepEqual(names(jar, 'https://deep.sub.example.com/'), ['a']);
  assert.deepEqual(names(jar, 'https://notexample.com/'), []);
  assert.deepEqual(names(jar, 'https://example.org/'), []);
});

test('Domain 없으면 host-only: 정확히 그 호스트에만', () => {
  const jar = new CookieJar();
  set(jar, 'a=1', 'https://example.com/');
  assert.deepEqual(names(jar, 'https://example.com/'), ['a']);
  assert.deepEqual(names(jar, 'https://sub.example.com/'), []);
});

test('다른 도메인 / 하위 도메인 / 최상위 도메인으로의 Domain 설정은 거부', () => {
  const jar = new CookieJar();
  assert.equal(set(jar, 'a=1; Domain=other.com', 'https://example.com/'), false);
  assert.equal(set(jar, 'a=1; Domain=sub.example.com', 'https://example.com/'), false);
  assert.equal(set(jar, 'a=1; Domain=com', 'https://example.com/'), false);
  assert.equal(jar.size, 0);
});

test('IP 주소는 완전 일치만', () => {
  const jar = new CookieJar();
  set(jar, 'a=1', 'http://127.0.0.1:8080/');
  assert.deepEqual(names(jar, 'http://127.0.0.1:9999/'), ['a']); // 쿠키는 포트를 구분하지 않음
  assert.deepEqual(names(jar, 'http://127.0.0.2/'), []);
});

// ---------- Path 매칭 ----------

test('Path 속성과 기본 경로', () => {
  const jar = new CookieJar();
  set(jar, 'p=1; Path=/docs', 'https://example.com/');
  set(jar, 'd=1', 'https://example.com/shop/cart/view'); // 기본 경로 /shop/cart
  set(jar, 'r=1; Path=relative', 'https://example.com/x/y'); // '/'로 시작 안 하면 기본 경로 /x
  assert.deepEqual(names(jar, 'https://example.com/docs'), ['p']);
  assert.deepEqual(names(jar, 'https://example.com/docs/a/b'), ['p']);
  assert.deepEqual(names(jar, 'https://example.com/docsx'), []);
  assert.deepEqual(names(jar, 'https://example.com/shop/cart/item'), ['d']);
  assert.deepEqual(names(jar, 'https://example.com/shop'), []);
  assert.deepEqual(names(jar, 'https://example.com/x/z'), ['r']);
});

test('Cookie 헤더 순서: 긴 경로 먼저, 같으면 먼저 만든 것 먼저', () => {
  const jar = new CookieJar();
  set(jar, 'root1=1; Path=/', 'https://example.com/');
  set(jar, 'deep=1; Path=/a/b', 'https://example.com/');
  set(jar, 'mid=1; Path=/a', 'https://example.com/');
  set(jar, 'root2=1; Path=/', 'https://example.com/');
  assert.equal(str(jar, 'https://example.com/a/b/c'), 'deep=1; mid=1; root1=1; root2=1');
});

// ---------- 만료 ----------

test('Max-Age: 지나면 만료되고 저장소에서도 제거', () => {
  const jar = new CookieJar();
  set(jar, 'a=1; Max-Age=60', 'https://example.com/');
  assert.deepEqual(names(jar, 'https://example.com/', { now: T0 + 59_000 }), ['a']);
  assert.deepEqual(names(jar, 'https://example.com/', { now: T0 + 60_000 }), []);
  assert.equal(jar.size, 0);
});

test('Expires: 미래면 유지, 과거면 기존 쿠키 삭제', () => {
  const jar = new CookieJar();
  set(jar, 'a=1; Expires=Fri, 01 Jan 2027 00:00:00 GMT', 'https://example.com/');
  set(jar, 'b=1', 'https://example.com/');
  assert.deepEqual(names(jar, 'https://example.com/'), ['a', 'b']);

  // 과거 날짜로 다시 보내는 것이 서버가 쿠키를 지우는 방법
  set(jar, 'b=; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'https://example.com/');
  assert.deepEqual(names(jar, 'https://example.com/'), ['a']);

  // 만료 시각이 되면 사라지고 저장소에서도 제거
  assert.deepEqual(names(jar, 'https://example.com/', { now: Date.UTC(2027, 0, 1) }), []);
  assert.equal(jar.size, 0);
});

test('Max-Age가 Expires보다 우선 (순서와 무관), Max-Age=0은 삭제', () => {
  const jar = new CookieJar();
  set(jar, 'a=1; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'https://example.com/');
  assert.deepEqual(names(jar, 'https://example.com/'), ['a']);
  set(jar, 'a=1; Max-Age=0', 'https://example.com/');
  assert.deepEqual(names(jar, 'https://example.com/'), []);
  set(jar, 'b=1', 'https://example.com/');
  set(jar, 'b=1; Max-Age=-1', 'https://example.com/');
  assert.equal(jar.size, 0);
});

test('Expires/Max-Age 없으면 세션 쿠키 (만료 없음)', () => {
  const jar = new CookieJar();
  set(jar, 'a=1', 'https://example.com/');
  assert.equal(jar.getCookies('https://example.com/', { now: T0 })[0].expires, null);
  assert.deepEqual(names(jar, 'https://example.com/', { now: T0 + 10 * 365 * 86400_000 }), ['a']);
});

// ---------- 덮어쓰기 ----------

test('같은 이름+도메인+경로면 덮어쓰기 (생성 순서 유지)', () => {
  const jar = new CookieJar();
  set(jar, 'a=1', 'https://example.com/');
  set(jar, 'b=1', 'https://example.com/');
  set(jar, 'a=2', 'https://example.com/', { now: T0 + 1000 });
  assert.equal(jar.size, 2);
  assert.equal(str(jar, 'https://example.com/'), 'a=2; b=1');
});

test('경로나 도메인이 다르면 같은 이름이라도 별개의 쿠키', () => {
  const jar = new CookieJar();
  set(jar, 'a=root; Path=/', 'https://www.example.com/');
  set(jar, 'a=sub; Path=/sub', 'https://www.example.com/');
  set(jar, 'a=parent; Domain=example.com', 'https://www.example.com/');
  assert.equal(jar.size, 3);
  assert.equal(str(jar, 'https://www.example.com/sub/x'), 'a=sub; a=root; a=parent');
  assert.equal(str(jar, 'https://example.com/sub/x'), 'a=parent');
});

test('쿠키 식별자는 이름+도메인+경로 (host-only 여부는 포함 안 됨, RFC 6265 5.3)', () => {
  const jar = new CookieJar();
  set(jar, 'a=hostonly', 'https://example.com/');
  set(jar, 'a=domain; Domain=example.com', 'https://example.com/');
  assert.equal(jar.size, 1);
  // 덮어쓴 쿠키는 이제 하위 도메인에도 적용
  assert.equal(str(jar, 'https://www.example.com/'), 'a=domain');
});

test('다른 사이트의 같은 이름 쿠키는 섞이지 않음', () => {
  const jar = new CookieJar();
  set(jar, 'session=AAA', 'https://site-a.com/');
  set(jar, 'session=BBB', 'https://site-b.com/');
  assert.equal(str(jar, 'https://site-a.com/'), 'session=AAA');
  assert.equal(str(jar, 'https://site-b.com/'), 'session=BBB');
});

// ---------- Secure / HttpOnly ----------

test('Secure 쿠키는 https 요청에만', () => {
  const jar = new CookieJar();
  set(jar, 's=1; Secure', 'https://example.com/');
  assert.deepEqual(names(jar, 'https://example.com/'), ['s']);
  assert.deepEqual(names(jar, 'http://example.com/'), []);
});

test('HttpOnly: 비-HTTP API(document.cookie)에서는 안 보이고, 설정/덮어쓰기 불가', () => {
  const jar = new CookieJar();
  set(jar, 'h=1; HttpOnly', 'https://example.com/');
  set(jar, 'v=1', 'https://example.com/');
  assert.equal(str(jar, 'https://example.com/'), 'h=1; v=1');
  assert.equal(str(jar, 'https://example.com/', { http: false }), 'v=1');

  assert.equal(set(jar, 'x=1; HttpOnly', 'https://example.com/', { http: false }), false);
  assert.equal(set(jar, 'h=hacked', 'https://example.com/', { http: false }), false);
  assert.equal(str(jar, 'https://example.com/'), 'h=1; v=1');
  assert.equal(set(jar, 'v=2', 'https://example.com/', { http: false }), true);
  assert.equal(str(jar, 'https://example.com/', { http: false }), 'v=2');
});

test('SameSite 값 보관', () => {
  const jar = new CookieJar();
  set(jar, 'a=1; SameSite=Strict', 'https://example.com/');
  assert.equal(jar.getCookies('https://example.com/', { now: T0 })[0].sameSite, 'strict');
});

// ---------- 영속화 ----------

test('CookieStore: 파일 저장 후 다시 불러오기 (만료된 쿠키는 저장 안 함)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cookie-test-'));
  try {
    const file = join(dir, 'nested', 'cookies.json');
    const store = new CookieStore({ file });
    const sid = store.create();
    store.get(sid).setCookie('keep=1; Max-Age=3600', 'https://example.com/');
    store.get(sid).setCookie('session=1; HttpOnly', 'https://example.com/');
    store.get(sid).setCookie('gone=1; Max-Age=1', 'https://example.com/', { now: Date.now() - 5000 });
    store.create(); // 쿠키 없는 세션은 저장 안 함
    assert.equal(store.dirty, true);
    await store.save();
    assert.equal(store.dirty, false);

    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(saved.sessions), [sid]);

    const reloaded = new CookieStore({ file }).load();
    assert.equal(reloaded.get(sid).getCookieString('https://example.com/'), 'keep=1; session=1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CookieStore: 파일이 없거나 깨져 있으면 빈 저장소로 시작', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cookie-test-'));
  try {
    assert.equal(new CookieStore({ file: join(dir, 'missing.json') }).load().sessions.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
