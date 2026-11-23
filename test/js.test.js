// 6단계: JS AST 변환 (src/rewrite/js.js) — 변환 전/후 코드 비교
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parse } from 'acorn';
import { generate } from 'astring';
import { rewriteJs, transformJs, rewriteFunctionArgs } from '../src/rewrite/js.js';

// 기대값도 같은 파서/출력기로 정규화해서 서식 차이 없이 비교
const norm = (code, sourceType = 'script', extra = {}) => generate(parse(code, { ecmaVersion: 'latest', sourceType, ...extra }));
// (바꿀 것이 없으면 변환기는 원본 문자열을 그대로 돌려주므로 결과 쪽도 정규화)
function same(input, expected, options = {}) {
  const st = options.sourceType === 'module' ? 'module' : 'script';
  const extra = options.handler ? { allowReturnOutsideFunction: true } : {};
  assert.equal(norm(rewriteJs(input, options), st, extra), norm(expected, st, extra));
}

test('1. 식별자 location 읽기/쓰기', () => {
  same('location.href = "/x"; var h = location.hash;', '__proxy.location.href = "/x"; var h = __proxy.location.hash;');
  same('location = "/next";', '__proxy.location = "/next";');
  same('if (typeof location !== "undefined") f(location);', 'if (typeof __proxy.location !== "undefined") f(__proxy.location);');
  same('location.assign("/a"); location.reload();', '__proxy.location.assign("/a"); __proxy.location.reload();');
});

test('2. window/document/self/globalThis/frames.location', () => {
  same(
    'window.location.href = "/a"; document.location = "/b"; self.location.replace("/c"); globalThis.location.search; frames.location;',
    '__proxy.location.href = "/a"; __proxy.location = "/b"; __proxy.location.replace("/c"); __proxy.location.search; __proxy.location;',
  );
  same('window["location"].href; document[`location`];', '__proxy.location.href; __proxy.location;');
});

test('3. top / parent (읽기만, 흔한 속성 이름은 그대로)', () => {
  same(
    'if (top !== self) top.location = location; var p = parent; window.top.postMessage(1); self.parent;',
    'if (__proxy.top !== self) __proxy.get(__proxy.top, "location") ; var p = __proxy.parent; __proxy.top.postMessage(1); __proxy.parent;'
      .replace('__proxy.get(__proxy.top, "location") ;', '__proxy.set(__proxy.top, "location", __proxy.location);'),
  );
  // rect.top, node.parent, style.top 대입, top/parent 대입(전역 변수처럼 쓰는 옛 코드)은 그대로
  same('el.style.top = rect.top + "px"; tree.parent.children; parent = node; top = 0;', 'el.style.top = rect.top + "px"; tree.parent.children; parent = node; top = 0;');
});

test('4. 스코프: 지역으로 선언된 location/top/parent는 건드리지 않음', () => {
  same('function f(location) { return location.href; }', 'function f(location) { return location.href; }');
  same('function g() { use(location); var location = 1; }', 'function g() { use(location); var location = 1; }'); // var 호이스팅
  same('{ let location = 1; location++; } location.href;', '{ let location = 1; location++; } __proxy.location.href;');
  same('try {} catch (location) { location.x; }', 'try {} catch (location) { location.x; }');
  same('const f = ({ top, parent: [location] }) => top + parent + location;', 'const f = ({ top, parent: [location] }) => top + __proxy.parent + location;');
  same('(function location() { location.name; })(); location;', '(function location() { location.name; })(); __proxy.location;');
  same('class top { m() { return top; } } parent;', 'class top { m() { return top; } } __proxy.parent;');
  same('for (let parent of xs) parent.y; parent.z;', 'for (let parent of xs) parent.y; __proxy.parent.z;');
});

test('5. 스크립트 최상위 var location 은 진짜 window.location, 모듈 최상위 선언은 지역', () => {
  same('var location = "/x"; location;', 'var location = "/x"; __proxy.location;');
  same('var top = 1; top;', 'var top = 1; top;'); // top/parent 는 스크립트 최상위 선언도 지역으로 본다
  same('let location = 1; export { location }; location;', 'let location = 1; export { location }; location;', { sourceType: 'module' });
  // 스크립트 최상위라도 let/const/class 는 새 렉시컬 변수
  same('const { location } = o; location;', 'const { location } = o; location;');
});

test('6. window/self 가 지역 변수면 런타임 확인(__proxy.get)', () => {
  same('function f(window) { return window.location; }', 'function f(window) { return __proxy.get(window, "location"); }');
  same('var self = this; self.location.href;', 'var self = this; __proxy.get(self, "location").href;');
});

test('7. 알 수 없는 객체의 .location 은 __proxy.get / __proxy.set', () => {
  same('frame.contentWindow.location.href = u;', '__proxy.get(frame.contentWindow, "location").href = u;');
  same('w.location = u; doc.location;', '__proxy.set(w, "location", u); __proxy.get(doc, "location");');
  same('a.location += "x";', '__proxy.get(a, "location") += "x";'.replace('__proxy.get(a, "location") += "x";', 'a.location += "x";'));
});

test('8. 계산된 접근 obj[key] (key가 리터럴이 아님)', () => {
  same('window["loc" + "ation"].href;', '__proxy.get(window, "loc" + "ation").href;');
  same('var v = obj[key]; obj[key] = 1; x = a[b][c];', 'var v = __proxy.get(obj, key); __proxy.set(obj, key, 1); x = __proxy.get(__proxy.get(a, b), c);');
  same('o[`${p}`];', '__proxy.get(o, `${p}`);');
  // 리터럴 키, 결과가 문자열일 수 없는 키는 그대로
  same('a[0]; a["x"]; a[i - 1]; a[i++]; a[-1]; a[n * 2]; a[!x];', 'a[0]; a["x"]; a[i - 1]; a[i++]; a[-1]; a[n * 2]; a[!x];');
});

test('9. 호출/복합 대입/delete/옵셔널 체인은 멤버 형태 유지', () => {
  // obj[key]() 는 this 유지가 필요하고 location 은 호출할 수 없다
  same('obj[k](1); obj[k] += 1; obj[k]++; delete obj[k]; tag[k]`x`;', 'obj[k](1); obj[k] += 1; obj[k]++; delete obj[k]; tag[k]`x`;');
  // 옵셔널 체인 안은 단락 평가 의미 때문에 그대로, 인자/계산된 키 안은 변환
  same('a?.[k].b; w?.location; a?.b(x[k]); a?.[y[k]];', 'a?.[k].b; w?.location; a?.b(__proxy.get(x, k)); a?.[__proxy.get(y, k)];');
  // 키와 값 안의 식도 변환
  same('o[k] = location;', '__proxy.set(o, k, __proxy.location);');
});

test('10. eval: direct eval 유지, 간접 eval, 지역 eval, 중복 변환 없음', () => {
  same('eval(code);', 'eval(__proxy.rewrite(code));');
  same('eval("location.href");', 'eval(__proxy.rewrite("location.href"));');
  same('window.eval(c); (0, eval)(c);', 'window.eval(__proxy.rewrite(c)); (0, eval)(__proxy.rewrite(c));');
  same('function f(eval) { eval(c); }', 'function f(eval) { eval(c); }');
  same('eval(__proxy.rewrite(c));', 'eval(__proxy.rewrite(c));');
  same('eval();', 'eval();');
});

test('11. new Function / Function / window.Function', () => {
  same('new Function("a", "b", "return a + b");', 'new Function(...__proxy.rewriteFunctionArgs(["a", "b", "return a + b"]));');
  same('Function(body)(); window.Function(x);', 'Function(...__proxy.rewriteFunctionArgs([body]))(); window.Function(...__proxy.rewriteFunctionArgs([x]));');
  same('new Function(...__proxy.rewriteFunctionArgs([b]));', 'new Function(...__proxy.rewriteFunctionArgs([b]));');
  same('function g(Function) { new Function(x); }', 'function g(Function) { new Function(x); }');
  assert.deepEqual(rewriteFunctionArgs(['a', 'return location.href + a']), ['a', norm('return __proxy.location.href + a', 'script', { allowReturnOutsideFunction: true })]);
});

test('12. 축약 속성과 구조 분해 대입', () => {
  same('x = { location, top };', 'x = { location: __proxy.location, top: __proxy.top };');
  same('({ location } = o); [location] = arr; ({ a: location = "/d" } = o);', '({ location: __proxy.location } = o); [__proxy.location] = arr; ({ a: __proxy.location = "/d" } = o);');
  same('const { location, a: { top } } = o; location;', 'const { location, a: { top } } = o; location;');
});

test('13. 속성 이름/메서드/레이블/클래스 멤버로 쓰인 location 은 그대로', () => {
  same(
    'o = { location: 1, top() {}, get parent() { return 1; } }; class C { location = 1; static top() {} } location: for (;;) break location;',
    'o = { location: 1, top() {}, get parent() { return 1; } }; class C { location = 1; static top() {} } location: for (;;) break location;',
  );
  same('o = { [location]: 1 };', 'o = { [__proxy.location]: 1 };');
});

test('14. 모듈: import/export 경로 변환, bare specifier 와 import.meta 는 그대로', () => {
  const base = 'https://site.com/js/app.js';
  same(
    'import a from "./a.js"; import { b } from "../lib/b.js"; import "/c.js"; import d from "https://cdn.com/d.js"; import r from "react"; export * from "./e.js"; export { f } from "//cdn.com/f.js"; const m = import("./lazy.js"); const n = import(name); import.meta.url; location;',
    'import a from "/p/https://site.com/js/a.js"; import { b } from "/p/https://site.com/lib/b.js"; import "/p/https://site.com/c.js"; import d from "/p/https://cdn.com/d.js"; import r from "react"; export * from "/p/https://site.com/js/e.js"; export { f } from "/p/https://cdn.com/f.js"; const m = import("/p/https://site.com/js/lazy.js"); const n = import(name); import.meta.url; __proxy.location;',
    { sourceType: 'module', base },
  );
  // sourceType 자동 판별: import 가 있으면 모듈
  const auto = transformJs('import x from "./x.js"; x(location);', { base });
  assert.equal(auto.sourceType, 'module');
  assert.equal(auto.code, norm('import x from "/p/https://site.com/js/x.js"; x(__proxy.location);', 'module'));
  // 최상위 await 도 모듈로 판별
  assert.equal(transformJs('await f(location);').sourceType, 'module');
  assert.equal(transformJs('with (o) { location; }').sourceType, 'script');
});

test('15. 이벤트 핸들러 본문 (return 허용)', () => {
  same('location.href = this.dataset.url; return false;', '__proxy.location.href = this.dataset.url; return false;', { handler: true });
});

test('16. 파싱 실패 시 원본 그대로 (ok: false)', () => {
  const broken = 'location.href = ; <!-- html comment';
  const r = transformJs(broken);
  assert.equal(r.ok, false);
  assert.equal(r.code, broken);
  assert.ok(r.error);
});

test('17. 바꿀 것이 없으면 파싱 없이 원본 그대로 (서식 보존)', () => {
  const code = 'function add(a, b) {\n    return a + b; // 더하기\n}';
  const r = transformJs(code);
  assert.equal(r.code, code);
  assert.equal(r.changed, false);
  // 파싱은 했지만 바뀐 것이 없어도 원본 그대로
  const withBracket = '/* keep */ const xs = [1, 2]; f(xs[0]);';
  assert.equal(rewriteJs(withBracket), withBracket);
});

test('18. prelude: 지시문("use strict") 뒤에 __proxy 대체 정의', () => {
  const out = rewriteJs('"use strict";\nlocation.href;', { prelude: true });
  assert.match(out, /^"use strict";\nif \(typeof globalThis\.__proxy === 'undefined'\)/);
  assert.match(out, /__proxy\.location\.href;\s*$/);
  // prelude 가 있으면 바꿀 것이 없어도 붙는다 (Worker 등에서 동작하도록)
  assert.match(rewriteJs('f(xs[0]);', { prelude: true }), /globalThis\.__proxy/);
  // __proxy 가 없는 전역(Worker 등)에서 실행해 보면 통과용 __proxy 가 생겨 원래대로 동작한다
  const sandbox = vm.createContext({ location: { href: 'W' }, obj: { a: 1 }, k: 'a' });
  vm.runInContext(rewriteJs('var r = location.href + obj[k]; obj[k] = 2;', { prelude: true }), sandbox);
  assert.equal(sandbox.r, 'W1');
  assert.equal(sandbox.obj.a, 2);
  // 이미 __proxy 가 있으면 덮어쓰지 않는다
  const existing = { location: { href: 'FAKE' }, get: (o, kk) => o[kk], set: (o, kk, v) => (o[kk] = v) };
  const sandbox2 = vm.createContext({ __proxy: existing });
  vm.runInContext(rewriteJs('var r = location.href;', { prelude: true }), sandbox2);
  assert.equal(sandbox2.r, 'FAKE');
});

test('19. 변환은 멱등 (두 번 변환해도 같음)', () => {
  const src = `
    var u = location.href, w = window['loc' + 'ation'], t = top, p = parent.frames;
    eval(code); new Function('a', body); obj[k] = location; doc.location.hash = '#x';
    function f(location) { return location; }
  `;
  const once = rewriteJs(src);
  assert.equal(rewriteJs(once), once);
});

test('20. 실행 결과: 가짜 __proxy 로 변환된 코드가 원본 대신 가짜 location 을 본다', () => {
  const fakeLocation = { href: 'https://site.com/page' };
  const calls = [];
  const fakeWindow = {};
  fakeWindow.window = fakeWindow;
  const __proxy = {
    location: fakeLocation,
    top: 'TOP',
    parent: 'PARENT',
    get: (o, k) => (k === 'location' && o === fakeWindow ? fakeLocation : o[k]),
    set: (o, k, v) => {
      calls.push(['set', k, v]);
      return v;
    },
    rewrite: (c) => c,
    rewriteFunctionArgs: (a) => a,
  };
  const code = rewriteJs(`
    var out = [];
    out.push(window['loc' + 'ation'].href);
    out.push(top, parent);
    out.push((function (location) { return location; })('local'));
    window['loc' + 'ation'] = '/moved';
    out;
  `);
  const out = new Function('__proxy', 'window', `${code.replace(/\n\s*out;\s*$/, '')}\nreturn out;`)(__proxy, fakeWindow);
  assert.deepEqual(out, ['https://site.com/page', 'TOP', 'PARENT', 'local']);
  assert.deepEqual(calls, [['set', 'location', '/moved']]);
});
