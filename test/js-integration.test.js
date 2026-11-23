// 6단계: HTML 인라인 스크립트/이벤트 속성, JS 응답 변환, 변환 캐시
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewriteHtml } from '../src/rewrite/html.js';
import { JsCache } from '../src/server/js-cache.js';
import { createProxyServer } from '../src/server/index.js';

const DOC = 'https://site.com/app/page';

test('HTML: 인라인 스크립트, 모듈 스크립트(import 경로), 이벤트 속성 변환', () => {
  const out = rewriteHtml(`<html><head>
<script>if (top !== self) top.location = location;</script>
<script type="module">import a from "./a.js"; a(location);</script>
<script type="text/javascript">window.location.href = "/x";</script>
</head><body><button onclick="location.href='/go'; return false">b</button></body></html>`, DOC);
  assert.match(out, /if \(__proxy\.top !== self\) __proxy\.set\(__proxy\.top, "location", __proxy\.location\);/);
  assert.match(out, /import a from "\/p\/https:\/\/site\.com\/app\/a\.js";\na\(__proxy\.location\);/);
  assert.match(out, /__proxy\.location\.href = "\/x";/);
  assert.match(out, /onclick="__proxy\.location\.href = '\/go';\nreturn false;\n"/);
});

test('HTML: JSON / JSON-LD / importmap / 템플릿 / src 있는 스크립트 본문은 그대로', () => {
  const html = `<html><head>
<script type="application/json">{"location": 1, "a": [top]}</script>
<script type="application/ld+json">{"@context": "location"}</script>
<script type="importmap">{"imports": {"x": "/x.js"}}</script>
<script type="text/template"><a href="{{location}}"></a></script>
<script src="a.js">location.href</script>
</head><body></body></html>`;
  const out = rewriteHtml(html, DOC);
  assert.match(out, /\{"location": 1, "a": \[top\]\}/);
  assert.match(out, /\{"@context": "location"\}/);
  assert.match(out, /\{"imports": \{"x": "\/x\.js"\}\}/);
  assert.match(out, /<a href="\{\{location\}\}"><\/a>/);
  assert.match(out, /<script src="\/p\/https:\/\/site\.com\/app\/a\.js">location\.href<\/script>/);
});

test('HTML: 파싱이 안 되는 인라인 스크립트는 원본 그대로 (페이지는 계속 동작)', () => {
  const out = rewriteHtml('<html><head><script>location.href = ;</script><script>location.reload()</script></head></html>', DOC);
  assert.match(out, /<script>location\.href = ;<\/script>/);
  assert.match(out, /__proxy\.location\.reload\(\)/);
});

test('HTML: 문자열 안의 </script> 는 원래 이스케이프 그대로 유지', () => {
  const out = rewriteHtml('<html><head><script>document.write("<script src=x><\\/script>"); location.x;</script></head></html>', DOC);
  assert.match(out, /"<script src=x><\\\/script>"/);
});

test('JsCache: 같은 내용은 한 번만 변환, LRU 용량 제한, 디스크 저장 후 재사용', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'js-cache-'));
  try {
    const big = `var x = location.href;\n${'// pad\n'.repeat(1000)}`;
    const cache = new JsCache({ dir });
    const a = await cache.rewrite(big, { base: 'https://a.com/x.js', prelude: true });
    const b = await cache.rewrite(big, { base: 'https://b.com/y.js', prelude: true }); // import 없으면 URL 무관
    assert.equal(a, b);
    assert.deepEqual(cache.stats, { hits: 1, diskHits: 0, misses: 1 });
    assert.equal(readdirSync(dir).length, 1);

    // 새 프로세스(빈 메모리)에서 디스크로 재사용
    const cache2 = new JsCache({ dir });
    assert.equal(await cache2.rewrite(big, { base: 'https://a.com/x.js', prelude: true }), a);
    assert.equal(cache2.stats.diskHits, 1);

    // import 가 있으면 URL 마다 다른 결과
    const mod = 'import x from "./x.js"; x(location);';
    assert.notEqual(await cache.rewrite(mod, { base: 'https://a.com/m.js' }), await cache.rewrite(mod, { base: 'https://b.com/m.js' }));

    // 용량 제한: 오래된 것부터 제거
    const small = new JsCache({ maxBytes: 100 });
    small.rewriteSync('location.a;');
    small.rewriteSync('location.b;');
    small.rewriteSync(`location.c; ${'x'.repeat(60)}`);
    assert.ok(small.bytes <= 100);
    assert.equal(small.memory.size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 프록시 서버를 거친 JS 응답 ----------

let origin, originUrl, proxy, proxyUrl;
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

before(async () => {
  origin = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    const send = (type, body) => {
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    };
    if (pathname === '/app.js') return send('application/javascript; charset=utf-8', '"use strict";\nif (top != self) top.location = location.href;');
    if (pathname === '/mod.js') return send('text/javascript', 'import { a } from "./lib/a.js";\nexport default location;');
    if (pathname === '/broken.js') return send('text/javascript', 'location.href = ;');
    if (pathname === '/data.json') return send('application/json', '{"location": 1}');
    res.writeHead(404);
    res.end();
  });
  originUrl = await listen(origin);
  proxy = createProxyServer();
  proxyUrl = await listen(proxy);
});
after(() => {
  for (const s of [proxy, origin]) {
    s.closeAllConnections();
    s.close();
  }
});

test('JS 응답: 변환 + prelude ("use strict" 유지), 모듈은 import 경로 변환', async () => {
  const res = await fetch(`${proxyUrl}/p/${originUrl}/app.js`);
  assert.equal(res.headers.get('content-type'), 'application/javascript; charset=utf-8');
  const js = await res.text();
  assert.match(js, /^"use strict";\nif \(typeof globalThis\.__proxy === 'undefined'\)/);
  assert.match(js, /if \(__proxy\.top != self\) __proxy\.set\(__proxy\.top, "location", __proxy\.location\.href\);/);

  const mod = await (await fetch(`${proxyUrl}/p/${originUrl}/mod.js`)).text();
  assert.match(mod, new RegExp(`import \\{a\\} from "/p/${originUrl}/lib/a\\.js";`));
  assert.match(mod, /export default __proxy\.location;/);
});

test('JS 응답: 파싱 실패는 원본 그대로, JSON 은 변환하지 않음', async () => {
  assert.equal(await (await fetch(`${proxyUrl}/p/${originUrl}/broken.js`)).text(), 'location.href = ;');
  assert.equal(await (await fetch(`${proxyUrl}/p/${originUrl}/data.json`)).text(), '{"location": 1}');
});

test('/__proxy/rewriter.js: 하나의 식으로 평가되어 변환기 객체를 돌려줌', async () => {
  const src = await (await fetch(`${proxyUrl}/__proxy/rewriter.js`)).text();
  const vm = await import('node:vm');
  const api = vm.runInNewContext(src, {});
  assert.equal(typeof api.rewriteJs, 'function');
  assert.equal(api.rewriteJs('location.href'), '__proxy.location.href;\n');
});
