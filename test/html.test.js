import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'parse5';
import { rewriteHtml, rewriteSrcset, HOOK_SCRIPT_SRC } from '../src/rewrite/html.js';

const DOC = 'https://example.com/wiki/Page';

// 변환 결과를 다시 파싱해 속성 값을 확인한다 (직렬화 형식에 의존하지 않도록)
function elements(html) {
  const out = [];
  const stack = [parse(html)];
  while (stack.length) {
    const n = stack.pop();
    if (n.attrs) out.push(n);
    const children = n.content ? n.content.childNodes : n.childNodes;
    if (children) stack.push(...[...children].reverse());
  }
  return out;
}
const attr = (el, name) => el.attrs.find((a) => a.name === name)?.value;
// 삽입된 hook 스크립트는 제외하고 찾는다 (hook 테스트는 head.childNodes로 직접 확인)
const isHook = (e) => e.tagName === 'script' && attr(e, 'src') === HOOK_SCRIPT_SRC;
const first = (html, tag) => elements(html).find((e) => e.tagName === tag && !isHook(e));
const all = (html, tag) => elements(html).filter((e) => e.tagName === tag && !isHook(e));
const rw = (body, url = DOC, opts) => rewriteHtml(`<!doctype html><html><head></head><body>${body}</body></html>`, url, opts);

test('href: 상대 / 루트 상대 / 절대 / 프로토콜 상대', () => {
  const out = rw(`
    <a href="Other">1</a>
    <a href="/wiki/Main">2</a>
    <a href="https://other.org/x?y=1&amp;z=2">3</a>
    <a href="//upload.example.net/a.png">4</a>
    <a href="../up">5</a>`);
  assert.deepEqual(all(out, 'a').map((a) => attr(a, 'href')), [
    '/p/https://example.com/wiki/Other',
    '/p/https://example.com/wiki/Main',
    '/p/https://other.org/x?y=1&z=2',
    '/p/https://upload.example.net/a.png',
    '/p/https://example.com/up',
  ]);
});

test('프록시 대상이 아닌 href는 그대로', () => {
  const out = rw(`
    <a href="#section">1</a>
    <a href="javascript:void(0)">2</a>
    <a href="mailto:a@b.c">3</a>
    <a href="">4</a>
    <img src="data:image/gif;base64,R0lGOD">`);
  assert.deepEqual(all(out, 'a').map((a) => attr(a, 'href')), ['#section', 'javascript:void(0)', 'mailto:a@b.c', '']);
  assert.equal(attr(first(out, 'img'), 'src'), 'data:image/gif;base64,R0lGOD');
});

test('src, action, formaction, poster, object data', () => {
  const out = rw(`
    <img src="a.png">
    <script src="//cdn.example.net/x.js"></script>
    <iframe src="/embed"></iframe>
    <form action="/search"><button formaction="go">b</button><input type="image" src="btn.png"></form>
    <video poster="p.jpg"><source src="v.mp4"><track src="t.vtt"></video>
    <object data="movie.swf"></object>
    <div data="not-a-url"></div>`);
  assert.equal(attr(first(out, 'img'), 'src'), '/p/https://example.com/wiki/a.png');
  assert.equal(attr(first(out, 'script'), 'src'), '/p/https://cdn.example.net/x.js');
  assert.equal(attr(first(out, 'iframe'), 'src'), '/p/https://example.com/embed');
  assert.equal(attr(first(out, 'form'), 'action'), '/p/https://example.com/search');
  assert.equal(attr(first(out, 'button'), 'formaction'), '/p/https://example.com/wiki/go');
  assert.equal(attr(first(out, 'input'), 'src'), '/p/https://example.com/wiki/btn.png');
  assert.equal(attr(first(out, 'video'), 'poster'), '/p/https://example.com/wiki/p.jpg');
  assert.equal(attr(first(out, 'source'), 'src'), '/p/https://example.com/wiki/v.mp4');
  assert.equal(attr(first(out, 'track'), 'src'), '/p/https://example.com/wiki/t.vtt');
  assert.equal(attr(first(out, 'object'), 'data'), '/p/https://example.com/wiki/movie.swf');
  assert.equal(attr(first(out, 'div'), 'data'), 'not-a-url');
});

test('srcset: 밀도/너비 서술자, 프로토콜 상대, data: URL 안의 쉼표', () => {
  assert.equal(
    rewriteSrcset('//up.example.net/a.png 1.5x, /b.png 2x', DOC),
    '/p/https://up.example.net/a.png 1.5x, /p/https://example.com/b.png 2x',
  );
  assert.equal(
    rewriteSrcset('small.jpg 480w,large.jpg 800w', DOC),
    '/p/https://example.com/wiki/small.jpg 480w, /p/https://example.com/wiki/large.jpg 800w',
  );
  assert.equal(rewriteSrcset('a.png', DOC), '/p/https://example.com/wiki/a.png');
  assert.equal(
    rewriteSrcset('data:image/png;base64,AA,BB 1x, c.png 2x', DOC),
    'data:image/png;base64,AA,BB 1x, /p/https://example.com/wiki/c.png 2x',
  );
  const out = rw('<picture><source srcset="w.webp 1x"><img srcset="i.png 2x" src="i.png"></picture>');
  assert.equal(attr(first(out, 'source'), 'srcset'), '/p/https://example.com/wiki/w.webp 1x');
  assert.equal(attr(first(out, 'img'), 'srcset'), '/p/https://example.com/wiki/i.png 2x');
});

test('<link> href와 imagesrcset', () => {
  const out = rewriteHtml(
    '<html><head><link rel="stylesheet" href="/w/load.php?lang=ko&amp;only=styles"><link rel="preload" as="image" imagesrcset="a.png 1x"></head></html>',
    DOC,
  );
  const links = all(out, 'link');
  assert.equal(attr(links[0], 'href'), '/p/https://example.com/w/load.php?lang=ko&only=styles');
  assert.equal(attr(links[1], 'imagesrcset'), '/p/https://example.com/wiki/a.png 1x');
});

test('<base href>: 기준 URL로 반영되고, base 자체도 프록시 경로로', () => {
  const out = rewriteHtml(
    '<html><head><base href="https://cdn.example.net/assets/"></head><body><img src="a.png"><a href="/root">r</a></body></html>',
    DOC,
  );
  assert.equal(attr(first(out, 'base'), 'href'), '/p/https://cdn.example.net/assets/');
  assert.equal(attr(first(out, 'img'), 'src'), '/p/https://cdn.example.net/assets/a.png');
  assert.equal(attr(first(out, 'a'), 'href'), '/p/https://cdn.example.net/root');
});

test('<base href> 상대값은 문서 URL 기준, 두 번째 base는 무시', () => {
  const out = rewriteHtml(
    '<html><head><base href="../static/"><base href="https://ignored.com/"></head><body><img src="x.png"></body></html>',
    DOC,
  );
  assert.equal(attr(first(out, 'img'), 'src'), '/p/https://example.com/static/x.png');
});

test('<meta http-equiv="refresh">', () => {
  const out = rewriteHtml(
    '<html><head><meta http-equiv="Refresh" content="5; url=/next?a=1"><meta http-equiv="refresh" content="0;URL=\'https://x.com/\'"><meta http-equiv="refresh" content="30"></head></html>',
    DOC,
  );
  assert.deepEqual(all(out, 'meta').map((m) => attr(m, 'content')), [
    '5; url=/p/https://example.com/next?a=1',
    "0;URL='/p/https://x.com/'",
    '30',
  ]);
});

test('style 속성과 <style> 태그는 css 변환', () => {
  const out = rewriteHtml(
    '<html><head><style>body{background:url(bg.png)} @import "x.css";</style></head><body><div style="background:url(//cdn.example.net/d.png)"></div></body></html>',
    DOC,
  );
  assert.match(out, /url\("\/p\/https:\/\/example\.com\/wiki\/bg\.png"\)/);
  assert.match(out, /@import "\/p\/https:\/\/example\.com\/wiki\/x\.css"/);
  assert.equal(attr(first(out, 'div'), 'style'), 'background:url("/p/https://cdn.example.net/d.png")');
});

test('integrity 속성 제거', () => {
  const out = rewriteHtml(
    '<html><head><script src="a.js" integrity="sha384-abc" crossorigin="anonymous"></script><link rel="stylesheet" href="a.css" integrity="sha256-x"></head></html>',
    DOC,
  );
  assert.equal(attr(first(out, 'script'), 'integrity'), undefined);
  assert.equal(attr(first(out, 'script'), 'crossorigin'), 'anonymous');
  assert.equal(attr(first(out, 'link'), 'integrity'), undefined);
});

test('<head> 맨 앞에 hook.js 삽입 (head가 없는 문서에도)', () => {
  const withHead = rewriteHtml('<html><head><meta charset="utf-8"><title>t</title></head></html>', DOC);
  const head = first(withHead, 'head');
  assert.equal(head.childNodes[0].tagName, 'script');
  assert.equal(attr(head.childNodes[0], 'src'), HOOK_SCRIPT_SRC);

  const noHead = rewriteHtml('<p>hi', DOC);
  assert.equal(attr(first(noHead, 'head').childNodes[0], 'src'), HOOK_SCRIPT_SRC);
  assert.equal(elements(noHead).filter(isHook).length, 1);
});

test('CSP meta 제거, charset meta는 utf-8로', () => {
  const out = rewriteHtml(
    `<html><head><meta charset="euc-kr"><meta http-equiv="Content-Type" content="text/html; charset=euc-kr">
     <meta http-equiv="Content-Security-Policy" content="default-src 'self'"></head></html>`,
    DOC,
  );
  const metas = all(out, 'meta');
  assert.equal(metas.length, 2);
  assert.equal(attr(metas[0], 'charset'), 'utf-8');
  assert.equal(attr(metas[1], 'content'), 'text/html; charset=utf-8');
});

test('원본이 EUC-KR이면 form에 accept-charset 추가', () => {
  const out = rw('<form action="/s"></form><form accept-charset="utf-8"></form>', DOC, { charset: 'euc-kr' });
  const forms = all(out, 'form');
  assert.equal(attr(forms[0], 'accept-charset'), 'euc-kr');
  assert.equal(attr(forms[1], 'accept-charset'), 'utf-8');
  const utf8 = rw('<form></form>');
  assert.equal(attr(first(utf8, 'form'), 'accept-charset'), undefined);
});

test('<template> 내용과 SVG xlink:href도 변환', () => {
  const out = rw(
    '<template><img src="t.png"></template><svg><image xlink:href="s.png"></image><use href="#icon"></use></svg>',
  );
  assert.equal(attr(first(out, 'img'), 'src'), '/p/https://example.com/wiki/t.png');
  assert.equal(attr(first(out, 'image'), 'href'), '/p/https://example.com/wiki/s.png');
  assert.equal(attr(first(out, 'use'), 'href'), '#icon');
});

test('인라인 스크립트와 텍스트는 건드리지 않음', () => {
  const out = rw('<script>var u = "/wiki/x"; if (a < b) {}</script><p>href="/x" 1 &lt; 2</p>');
  assert.match(out, /var u = "\/wiki\/x"; if \(a < b\) \{\}/);
  assert.match(out, /href="\/x" 1 &lt; 2/);
});
