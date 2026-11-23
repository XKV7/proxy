// 3단계: 프록시를 거친 쿠키 저장/전송, 사이트별 분리, 세션별 분리, document.cookie API
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxyServer } from '../src/server/index.js';
import { CookieStore, SESSION_COOKIE } from '../src/server/cookies.js';

// httpbin.org 의 /cookies/set, /cookies 와 같은 동작을 하는 원본 서버
function cookieSite() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/cookies/set') {
      const headers = [...u.searchParams].map(([k, v]) => `${k}=${v}; Path=/`);
      res.writeHead(302, { location: '/cookies', 'set-cookie': headers });
      return res.end();
    }
    if (u.pathname === '/cookies/login') {
      res.writeHead(200, { 'set-cookie': ['token=secret; Path=/; HttpOnly', 'theme=dark; Path=/'] });
      return res.end('ok');
    }
    if (u.pathname === '/cookies') {
      const cookies = {};
      for (const part of (req.headers.cookie ?? '').split('; ').filter(Boolean)) {
        const i = part.indexOf('=');
        cookies[part.slice(0, i)] = part.slice(i + 1);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ cookies }));
    }
    res.writeHead(404);
    res.end();
  });
}

let siteA, siteB, proxy, proxyUrl, A, B, dir, store;
const listen = (server, host = '127.0.0.1') =>
  new Promise((r) => server.listen(0, host, () => r(server.address().port)));

before(async () => {
  siteA = cookieSite();
  siteB = cookieSite();
  // 같은 머신이지만 호스트 이름이 다르면 쿠키 입장에서 다른 사이트
  A = `http://127.0.0.1:${await listen(siteA)}`;
  B = `http://localhost:${await listen(siteB)}`;
  dir = mkdtempSync(join(tmpdir(), 'cookie-int-'));
  store = new CookieStore({ file: join(dir, 'cookies.json') });
  proxy = createProxyServer({ cookieStore: store });
  proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
});

after(() => {
  for (const s of [proxy, siteA, siteB]) {
    s.closeAllConnections();
    s.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

// 브라우저 하나를 흉내 낸다: localhost 쿠키(__proxy_sid)를 기억하고, 리다이렉트를 따라간다
function browser() {
  let sid = null;
  const request = async (path, init = {}) => {
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(proxyUrl + path, {
        redirect: 'manual',
        ...init,
        headers: { ...init.headers, ...(sid ? { cookie: `${SESSION_COOKIE}=${sid}` } : {}) },
      });
      for (const sc of res.headers.getSetCookie()) {
        const m = new RegExp(`^${SESSION_COOKIE}=([^;]+)`).exec(sc);
        if (m) sid = m[1];
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        path = res.headers.get('location');
        continue;
      }
      return res;
    }
    throw new Error('too many redirects');
  };
  return { request, get sid() { return sid; } };
}

const cookiesOf = async (b, site) => (await (await b.request(`/p/${site}/cookies`)).json()).cookies;

test('/cookies/set?a=1 -> /cookies 에서 쿠키 유지 (httpbin 흐름)', async () => {
  const b = browser();
  const res = await b.request(`/p/${A}/cookies/set?a=1`);
  assert.deepEqual((await res.json()).cookies, { a: '1' });
  assert.deepEqual(await cookiesOf(b, A), { a: '1' });
});

test('브라우저로 가는 Set-Cookie는 __proxy_sid(HttpOnly) 하나뿐, 첫 요청에만', async () => {
  const b = browser();
  const first = await fetch(`${proxyUrl}/p/${A}/cookies/set?x=1`, { redirect: 'manual' });
  const setCookies = first.headers.getSetCookie();
  assert.equal(setCookies.length, 1);
  assert.match(setCookies[0], new RegExp(`^${SESSION_COOKIE}=[\\w-]+; Path=/; Max-Age=\\d+; HttpOnly; SameSite=Lax$`));

  await b.request(`/p/${A}/cookies`);
  const again = await b.request(`/p/${A}/cookies`);
  assert.deepEqual(again.headers.getSetCookie(), []);
});

test('두 사이트가 같은 이름 쿠키를 써도 섞이지 않음', async () => {
  const b = browser();
  await b.request(`/p/${A}/cookies/set?session=AAA`);
  await b.request(`/p/${B}/cookies/set?session=BBB`);
  assert.deepEqual(await cookiesOf(b, A), { session: 'AAA' });
  assert.deepEqual(await cookiesOf(b, B), { session: 'BBB' });
});

test('브라우저(세션)끼리도 섞이지 않음', async () => {
  const alice = browser();
  const bob = browser();
  await alice.request(`/p/${A}/cookies/set?user=alice`);
  await bob.request(`/p/${A}/cookies/set?user=bob`);
  assert.deepEqual(await cookiesOf(alice, A), { user: 'alice' });
  assert.deepEqual(await cookiesOf(bob, A), { user: 'bob' });
  assert.notEqual(alice.sid, bob.sid);
});

test('서버가 모르는 __proxy_sid는 새 세션으로 교체', async () => {
  const res = await fetch(`${proxyUrl}/p/${A}/cookies`, { headers: { cookie: `${SESSION_COOKIE}=forged` } });
  const sc = res.headers.getSetCookie()[0];
  assert.ok(sc && !sc.startsWith(`${SESSION_COOKIE}=forged`));
  assert.deepEqual((await res.json()).cookies, {});
});

test('document.cookie API: GET은 HttpOnly 제외, POST로 설정', async () => {
  const b = browser();
  await b.request(`/p/${A}/cookies/login`);
  const api = (init) => b.request(`/__proxy/cookies?url=${encodeURIComponent(`${A}/page`)}`, init);

  const get = await api();
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await get.json(), { cookie: 'theme=dark' });

  const post = await api({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'lang=ko; path=/' });
  assert.deepEqual(await post.json(), { cookie: 'theme=dark; lang=ko' });

  // HttpOnly 쿠키는 JS로 덮어쓸 수 없다
  await api({ method: 'POST', body: 'token=hacked; path=/' });
  // JS로 설정한 쿠키도 원본 요청에 실려 간다
  assert.deepEqual(await cookiesOf(b, A), { token: 'secret', theme: 'dark', lang: 'ko' });
});

test('document.cookie API: 잘못된 요청', async () => {
  assert.equal((await fetch(`${proxyUrl}/__proxy/cookies`)).status, 400);
  assert.equal((await fetch(`${proxyUrl}/__proxy/cookies?url=javascript:1`)).status, 400);
  assert.equal((await fetch(`${proxyUrl}/__proxy/cookies?url=${encodeURIComponent(A)}`, { method: 'PUT' })).status, 405);
  const big = await fetch(`${proxyUrl}/__proxy/cookies?url=${encodeURIComponent(A)}`, { method: 'POST', body: 'a='.padEnd(10_000, 'x') });
  assert.equal(big.status, 413);
});

test('서버 재시작(파일에서 다시 로드) 후에도 쿠키 유지', async () => {
  const b = browser();
  await b.request(`/p/${A}/cookies/set?persist=yes`);
  await store.save();

  const restarted = createProxyServer({ cookieStore: new CookieStore({ file: store.file }).load() });
  const port = await listen(restarted);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/p/${A}/cookies`, { headers: { cookie: `${SESSION_COOKIE}=${b.sid}` } });
    assert.deepEqual(res.headers.getSetCookie(), []);
    assert.deepEqual((await res.json()).cookies, { persist: 'yes' });
  } finally {
    restarted.closeAllConnections();
    restarted.close();
  }
});
