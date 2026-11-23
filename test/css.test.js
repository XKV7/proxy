import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteCss, rewriteInlineStyle, rewriteCssUrls } from '../src/rewrite/css.js';

const BASE = 'https://example.com/styles/main.css';

test('url(): 상대 / 루트 상대 / 절대 / 프로토콜 상대', () => {
  const css = `
a { background: url(img/a.png); }
b { background: url('../b.png'); }
c { background: url("/c.png"); }
d { background: url(https://other.com/d.png); }
e { background: url(//cdn.example.net/e.png); }`;
  const out = rewriteCss(css, BASE);
  assert.match(out, /url\("\/p\/https:\/\/example\.com\/styles\/img\/a\.png"\)/);
  assert.match(out, /url\("\/p\/https:\/\/example\.com\/b\.png"\)/);
  assert.match(out, /url\("\/p\/https:\/\/example\.com\/c\.png"\)/);
  assert.match(out, /url\("\/p\/https:\/\/other\.com\/d\.png"\)/);
  assert.match(out, /url\("\/p\/https:\/\/cdn\.example\.net\/e\.png"\)/);
});

test('url(): 공백, 대소문자, 한 값에 여러 개', () => {
  const out = rewriteCss('a{background:URL( a.png ), url(b.png) no-repeat}', BASE);
  assert.equal(
    out,
    'a{background:url("/p/https://example.com/styles/a.png"), url("/p/https://example.com/styles/b.png") no-repeat}',
  );
});

test('url(): data:, #frag, 빈 값은 그대로', () => {
  const css = 'a{background:url(data:image/png;base64,AAA=)} b{filter:url(#blur)} c{background:url()}';
  assert.equal(rewriteCss(css, BASE), css);
});

test('@font-face src', () => {
  const out = rewriteCss(
    '@font-face{font-family:F;src:local(F),url(f.woff2) format("woff2"),url("f.woff") format("woff")}',
    BASE,
  );
  assert.match(out, /url\("\/p\/https:\/\/example\.com\/styles\/f\.woff2"\) format\("woff2"\)/);
  assert.match(out, /url\("\/p\/https:\/\/example\.com\/styles\/f\.woff"\) format\("woff"\)/);
  assert.match(out, /local\(F\)/);
});

test('@import: 문자열 / url() / 미디어 쿼리 유지', () => {
  const out = rewriteCss(
    `@import "reset.css";
@import url(//cdn.example.net/x.css) screen;
@import 'print.css' print;`,
    BASE,
  );
  assert.match(out, /@import "\/p\/https:\/\/example\.com\/styles\/reset\.css";/);
  assert.match(out, /@import url\("\/p\/https:\/\/cdn\.example\.net\/x\.css"\) screen;/);
  assert.match(out, /@import "\/p\/https:\/\/example\.com\/styles\/print\.css" print;/);
});

test('@charset 제거, @namespace url은 그대로', () => {
  const out = rewriteCss('@charset "euc-kr";\n@namespace svg url(http://www.w3.org/2000/svg);\na{}', BASE);
  assert.doesNotMatch(out, /@charset/);
  assert.match(out, /@namespace svg url\(http:\/\/www\.w3\.org\/2000\/svg\)/);
});

test('@media 안의 규칙, 서식 보존', () => {
  const css = '/* c */\n@media (max-width: 600px) {\n  .x { background: url(m.png); }\n}\n';
  assert.equal(
    rewriteCss(css, BASE),
    '/* c */\n@media (max-width: 600px) {\n  .x { background: url("/p/https://example.com/styles/m.png"); }\n}\n',
  );
});

test('문법이 깨진 CSS도 url()은 변환', () => {
  const out = rewriteCss('a { background: url(x.png) ', BASE);
  assert.match(out, /url\("\/p\/https:\/\/example\.com\/styles\/x\.png"\)/);
  const broken = rewriteCss('}}} a{background:url(y.png)} {{', BASE);
  assert.match(broken, /\/p\/https:\/\/example\.com\/styles\/y\.png/);
});

test('style 속성 (선언 목록)', () => {
  assert.equal(
    rewriteInlineStyle('color: red; background-image: url(\'bg.jpg\')', 'https://example.com/page/'),
    'color: red; background-image: url("/p/https://example.com/page/bg.jpg")',
  );
  assert.equal(rewriteInlineStyle('color: red', BASE), 'color: red');
});

test('URL 안의 괄호/따옴표도 안전하게 직렬화', () => {
  const out = rewriteCssUrls('url("a(1).png") url(\'q"x.png\')', 'https://example.com/');
  assert.equal(out, 'url("/p/https://example.com/a(1).png") url("/p/https://example.com/q%22x.png")');
});
