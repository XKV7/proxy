// JS 코드 변환 (acorn으로 파싱 -> AST 수정 -> astring으로 출력)
//
// 브라우저의 location, top 등은 덮어쓸 수 없으므로(LegacyUnforgeable) 코드 자체를 바꿔
// hook.js가 만든 window.__proxy 쪽을 보게 한다.
//
//   location / window.location / document.location ...  -> __proxy.location
//   top, parent / window.top ...                          -> __proxy.top, __proxy.parent
//   x.location (x를 정적으로 알 수 없음)                  -> __proxy.get(x, 'location')
//   obj[key] (key가 리터럴이 아님)                         -> __proxy.get(obj, key) / 대입은 __proxy.set
//   eval(code)                                             -> eval(__proxy.rewrite(code))   (direct eval 유지)
//   new Function(a, b, body)                               -> new Function(...__proxy.rewriteFunctionArgs([a, b, body]))
//   import '...' (모듈)                                    -> 프록시 경로
//
// 이 파일은 서버(Node)와 브라우저(/__proxy/rewriter.js, 런타임 eval 변환용) 양쪽에서 쓰인다.
import { parse as acornParse } from 'acorn';
import { generate } from 'astring';
import { proxify } from '../shared/url.js';

// 변환 규칙을 바꾸면 올린다 (캐시 키에 포함)
export const REWRITER_VERSION = 1;

const DEBUG = typeof process !== 'undefined' && process.env?.DEBUG === '1';
const debug = DEBUG ? (...a) => console.log('[js]', ...a) : () => {};

const SPECIAL = new Set(['location', 'top', 'parent']);
// window와 같은 객체를 가리키는 전역 이름
const GLOBAL_OBJECTS = new Set(['window', 'self', 'globalThis', 'frames']);
// 스코프 분석에서 추적할 이름 (이 이름들이 지역 선언되면 변환하지 않음)
const WATCHED = new Set([...SPECIAL, ...GLOBAL_OBJECTS, 'document', 'eval', 'Function']);
// 이 단어들이 하나도 없으면 바꿀 것이 없으므로 파싱하지 않는다
const QUICK_CHECK = /location|top|parent|eval|Function|\[|import|export/;

// 외부 JS 파일 앞에 붙이는 코드: hook.js가 없는 곳(Worker 등)에서도 변환된 코드가 죽지 않도록
// 아무 일도 하지 않는 __proxy를 만들어 둔다 (페이지에서는 hook.js가 이미 만들어 둠)
const PRELUDE_SOURCE = `if (typeof globalThis.__proxy === 'undefined') globalThis.__proxy = {
  location: globalThis.location, top: globalThis, parent: globalThis,
  get: (o, k) => o[k], set: (o, k, v) => (o[k] = v),
  rewrite: (c) => c, rewriteFunctionArgs: (a) => a,
};`;
let preludeAst = null;

/**
 * @typedef {object} RewriteOptions
 * @property {'script'|'module'|'auto'} [sourceType] auto: script로 먼저 시도하고 실패하면 module
 * @property {string} [base] 모듈 import 경로 해석 기준 (원본 URL). 없으면 import 경로는 그대로
 * @property {boolean} [handler] onclick 속성 같은 이벤트 핸들러 본문 (return 허용)
 * @property {boolean} [prelude] 외부 JS 파일: __proxy 대체 정의를 앞에 붙임
 */

/**
 * @param {string} code
 * @param {RewriteOptions} [options]
 * @returns {{ code: string, ok: boolean, changed: boolean, sourceType?: string, error?: Error }}
 */
export function transformJs(code, { sourceType = 'auto', base, handler = false, prelude = false } = {}) {
  if (typeof code !== 'string' || !QUICK_CHECK.test(code)) {
    return { code, ok: true, changed: false };
  }
  let ast;
  let type;
  try {
    ({ ast, sourceType: type } = parseJs(code, sourceType, handler));
  } catch (error) {
    // 사이트 전체가 죽지 않게 원본 그대로
    debug('파싱 실패, 원본 유지:', error.message, base ?? '');
    return { code, ok: false, changed: false, error };
  }
  const scopes = analyzeScopes(ast, type);
  const state = { scopes, base, module: type === 'module', changed: false };
  transform(ast, scopes.get(ast), state, { inChain: false });
  if (prelude) insertPrelude(ast);
  if (!state.changed && !prelude) return { code, ok: true, changed: false, sourceType: type };
  return { code: generate(ast), ok: true, changed: true, sourceType: type };
}

/** transformJs의 결과 코드만 */
export function rewriteJs(code, options) {
  return transformJs(code, options).code;
}

/** new Function(...args) 의 인자: 마지막이 함수 본문 */
export function rewriteFunctionArgs(args, options) {
  const out = [...args];
  if (out.length && typeof out[out.length - 1] === 'string') {
    out[out.length - 1] = rewriteJs(out[out.length - 1], { ...options, sourceType: 'script', handler: true });
  }
  return out;
}

function parseJs(code, sourceType, handler) {
  const options = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: handler };
  if (sourceType !== 'auto') return { ast: acornParse(code, { ...options, sourceType }), sourceType };
  try {
    return { ast: acornParse(code, { ...options, sourceType: 'script' }), sourceType: 'script' };
  } catch (scriptError) {
    try {
      return { ast: acornParse(code, { ...options, sourceType: 'module' }), sourceType: 'module' };
    } catch {
      throw scriptError;
    }
  }
}

function insertPrelude(ast) {
  preludeAst ??= acornParse(PRELUDE_SOURCE, { ecmaVersion: 'latest' }).body;
  // 'use strict' 같은 지시문 뒤에 넣어야 지시문이 유지된다
  let i = 0;
  while (i < ast.body.length && ast.body[i].directive !== undefined) i++;
  ast.body.splice(i, 0, ...structuredClone(preludeAst));
}

// ---------------------------------------------------------------------------
// 1단계: 스코프 분석 — 어떤 이름이 어느 스코프에 선언됐는지
// ---------------------------------------------------------------------------

class Scope {
  constructor(parent, kind) {
    this.parent = parent;
    this.kind = kind; // 'script' | 'module' | 'function' | 'block'
    this.names = new Set();
    this.lexical = new Set(); // let/const/class/import 로 선언된 이름
  }
}

function isNode(v) {
  return v !== null && typeof v === 'object' && typeof v.type === 'string';
}

function forEachChild(node, fn) {
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) fn(c);
    } else if (isNode(v)) {
      fn(v);
    }
  }
}

function patternNames(p, out = []) {
  if (!p) return out;
  switch (p.type) {
    case 'Identifier': out.push(p.name); break;
    case 'ObjectPattern': for (const prop of p.properties) patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out); break;
    case 'ArrayPattern': for (const el of p.elements) patternNames(el, out); break;
    case 'AssignmentPattern': patternNames(p.left, out); break;
    case 'RestElement': patternNames(p.argument, out); break;
  }
  return out;
}

function declare(scope, names, lexical = false) {
  for (const n of names) {
    if (!WATCHED.has(n)) continue;
    scope.names.add(n);
    if (lexical) scope.lexical.add(n);
  }
}

/** @returns {Map<object, Scope>} 스코프를 만드는 노드 -> Scope */
function analyzeScopes(ast, sourceType) {
  const scopes = new Map();
  const program = new Scope(null, sourceType === 'module' ? 'module' : 'script');
  scopes.set(ast, program);

  function fn(node, scope) {
    const f = new Scope(scope, 'function');
    scopes.set(node, f);
    if (node.type === 'FunctionExpression' && node.id) declare(f, [node.id.name]);
    for (const p of node.params) {
      declare(f, patternNames(p));
      visit(p, f, f);
    }
    // 함수 본문 블록은 함수 스코프를 그대로 쓴다
    if (node.body.type === 'BlockStatement') for (const s of node.body.body) visit(s, f, f);
    else visit(node.body, f, f);
  }

  function visit(node, scope, fnScope) {
    switch (node.type) {
      case 'FunctionDeclaration':
        if (node.id) declare(scope, [node.id.name]);
        return fn(node, scope);
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return fn(node, scope);
      case 'ClassDeclaration':
      case 'ClassExpression': {
        if (node.type === 'ClassDeclaration' && node.id) declare(scope, [node.id.name], true);
        const c = new Scope(scope, 'block');
        if (node.type === 'ClassExpression' && node.id) declare(c, [node.id.name]);
        scopes.set(node, c);
        if (node.superClass) visit(node.superClass, c, fnScope);
        return visit(node.body, c, fnScope);
      }
      case 'VariableDeclaration':
        for (const d of node.declarations) {
          if (node.kind === 'var') declare(fnScope, patternNames(d.id));
          else declare(scope, patternNames(d.id), true);
        }
        break;
      case 'ImportDeclaration':
        declare(scope, node.specifiers.map((s) => s.local.name), true);
        return;
      case 'CatchClause': {
        const c = new Scope(scope, 'block');
        scopes.set(node, c);
        declare(c, patternNames(node.param));
        if (node.param) visit(node.param, c, fnScope);
        return visit(node.body, c, fnScope);
      }
      case 'StaticBlock': {
        const s = new Scope(scope, 'function');
        scopes.set(node, s);
        for (const st of node.body) visit(st, s, s);
        return;
      }
      case 'BlockStatement':
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
      case 'SwitchStatement': {
        const b = new Scope(scope, 'block');
        scopes.set(node, b);
        forEachChild(node, (c) => visit(c, b, fnScope));
        return;
      }
    }
    forEachChild(node, (c) => visit(c, scope, fnScope));
  }

  for (const s of ast.body) visit(s, program, program);
  return scopes;
}

/** name이 지역 선언으로 가려졌는가 */
function isShadowed(name, scope) {
  for (let s = scope; s; s = s.parent) {
    if (!s.names.has(name)) continue;
    // 일반 스크립트 최상위의 var/function location 은 새 변수가 아니라 진짜 window.location 이다
    // (let/const/class 는 전역 렉시컬 환경에 새 변수를 만든다)
    if (s.kind === 'script' && name === 'location' && !s.lexical.has(name)) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 2단계: 변환
// ---------------------------------------------------------------------------

const ident = (name) => ({ type: 'Identifier', name });
const member = (object, name) => ({ type: 'MemberExpression', object, property: ident(name), computed: false, optional: false });
const proxyMember = (name) => member(ident('__proxy'), name);
const callExpr = (callee, args) => ({ type: 'CallExpression', callee, arguments: args, optional: false });
const literal = (value) => ({ type: 'Literal', value, raw: JSON.stringify(value) });

/** obj.name / obj['name'] / obj[`name`] 의 이름. 정적으로 알 수 없으면 null */
function staticMemberName(node) {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const p = node.property;
  if (p.type === 'Literal' && typeof p.value === 'string') return p.value;
  if (p.type === 'TemplateLiteral' && p.expressions.length === 0) return p.quasis[0].value.cooked;
  return null;
}

// 결과가 문자열일 수 없는 키 (숫자/불리언/undefined) -> location 등이 될 수 없으므로 __proxy.get 불필요
const NON_STRING_BINARY = new Set(['-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>', '==', '!=', '===', '!==', '<', '<=', '>', '>=', 'in', 'instanceof']);
function keyMayBeSpecial(key) {
  switch (key.type) {
    case 'Literal': return false;
    case 'UpdateExpression': return false;
    case 'UnaryExpression': return false; // -x, +x, ~x, !x, void x 는 문자열이 아니고, typeof 결과('object' 등)는 특수 이름이 아님
    case 'BinaryExpression': return !NON_STRING_BINARY.has(key.operator);
    case 'TemplateLiteral': return key.expressions.length > 0;
    default: return true;
  }
}

const isIdent = (node, name) => node?.type === 'Identifier' && node.name === name;
const isProxyCall = (node, method) =>
  node?.type === 'CallExpression' && node.callee.type === 'MemberExpression' && isIdent(node.callee.object, '__proxy') && isIdent(node.callee.property, method);

/** window/self/globalThis/frames (document 포함 여부 선택) 를 가리키는 전역 참조인가 */
function isGlobalObject(node, scope, allowDocument) {
  if (node.type !== 'Identifier') return false;
  const ok = GLOBAL_OBJECTS.has(node.name) || (allowDocument && node.name === 'document');
  return ok && !isShadowed(node.name, scope);
}

function isGlobalFunctionCtor(callee, scope) {
  if (isIdent(callee, 'Function')) return !isShadowed('Function', scope);
  return callee.type === 'MemberExpression' && staticMemberName(callee) === 'Function' && isGlobalObject(callee.object, scope, false);
}

function isEvalCallee(callee, scope) {
  if (isIdent(callee, 'eval')) return !isShadowed('eval', scope);
  // window.eval(x), (0, eval)(x) — 간접 eval
  if (callee.type === 'MemberExpression') return staticMemberName(callee) === 'eval' && isGlobalObject(callee.object, scope, false);
  if (callee.type === 'SequenceExpression') {
    const last = callee.expressions[callee.expressions.length - 1];
    return isIdent(last, 'eval') && !isShadowed('eval', scope);
  }
  return false;
}

/** 모듈 import 경로: 상대/절대 경로만 바꾸고, 'react' 같은 bare specifier(import map 대상)는 그대로 */
function rewriteSpecifier(lit, state) {
  if (!state.base || lit?.type !== 'Literal' || typeof lit.value !== 'string') return lit;
  const spec = lit.value;
  if (!/^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(spec)) return lit;
  const next = proxify(spec, state.base);
  if (next === spec) return lit;
  state.changed = true;
  return literal(next);
}

/**
 * 노드를 변환해 (새) 노드를 돌려준다. 자식은 제자리에서 바꾼다.
 * ctx.inChain: 옵셔널 체인(a?.b) 안 — 단락 평가 의미를 지키기 위해 멤버 변환을 하지 않는다
 */
function transform(node, scope, state, ctx) {
  if (!node) return node;
  const t = (n, s = scope, c = ctx) => transform(n, s, state, c);
  const scopeOf = (n) => state.scopes.get(n) ?? scope;
  const changed = (n) => {
    state.changed = true;
    return n;
  };

  switch (node.type) {
    case 'Program': {
      node.body = node.body.map((s) => t(s, scopeOf(node)));
      return node;
    }

    case 'Identifier': {
      // 여기 오는 Identifier는 "값을 읽는 참조" 위치뿐이다 (선언/속성 이름/레이블은 따로 처리)
      if (SPECIAL.has(node.name) && !isShadowed(node.name, scope)) return changed(proxyMember(node.name));
      return node;
    }

    case 'MemberExpression':
      return transformMember(node, scope, state, ctx, 'get');

    case 'ChainExpression':
      node.expression = t(node.expression, scope, { ...ctx, inChain: true });
      return node;

    case 'AssignmentExpression': {
      const left = node.left;
      node.right = t(node.right);
      if (left.type === 'Identifier') {
        // location = '/x' 는 이동. top/parent 대입은 (전역 변수처럼 쓰는 옛 코드일 수 있어) 그대로
        if (node.operator === '=' && left.name === 'location' && !isShadowed('location', scope)) {
          node.left = changed(proxyMember('location'));
        }
        return node;
      }
      if (left.type === 'MemberExpression') {
        if (node.operator !== '=') {
          // 복합 대입(+= 등)은 읽기와 쓰기를 함께 하므로 멤버 형태를 유지한다
          walkMemberParts(left, t);
          return node;
        }
        const name = staticMemberName(left);
        if (name === 'location' && left.object.type !== 'Super' && !isIdent(left.object, '__proxy')) {
          if (isGlobalObject(left.object, scope, true)) {
            node.left = changed(proxyMember('location'));
            return node;
          }
          return changed(callExpr(proxyMember('set'), [t(left.object), literal('location'), node.right]));
        }
        if (left.computed && name === null && keyMayBeSpecial(left.property) && left.object.type !== 'Super') {
          return changed(callExpr(proxyMember('set'), [t(left.object), t(left.property), node.right]));
        }
        walkMemberParts(left, t);
        return node;
      }
      node.left = transformPattern(left, scope, state, 'assign');
      return node;
    }

    case 'UpdateExpression':
      if (node.argument.type === 'MemberExpression') walkMemberParts(node.argument, t);
      return node; // location++ 같은 것은 의미가 없으므로 그대로

    case 'UnaryExpression':
      if (node.operator === 'delete') {
        if (node.argument.type === 'MemberExpression') walkMemberParts(node.argument, t);
        return node;
      }
      node.argument = t(node.argument);
      return node;

    case 'CallExpression':
    case 'NewExpression': {
      const callee = node.callee;
      // 인자는 옵셔널 체인의 단락 평가와 무관하므로 체인 밖과 같이 변환
      node.arguments = node.arguments.map((a) => t(a, scope, { inChain: false }));
      if (node.type === 'CallExpression' && isEvalCallee(callee, scope)) {
        const first = node.arguments[0];
        if (first && first.type !== 'SpreadElement' && !isProxyCall(first, 'rewrite')) {
          node.arguments[0] = changed(callExpr(proxyMember('rewrite'), [first]));
        }
      } else if (isGlobalFunctionCtor(callee, scope)) {
        const already = node.arguments.length === 1 && node.arguments[0].type === 'SpreadElement' && isProxyCall(node.arguments[0].argument, 'rewriteFunctionArgs');
        if (!already && node.arguments.length) {
          node.arguments = [changed({
            type: 'SpreadElement',
            argument: callExpr(proxyMember('rewriteFunctionArgs'), [{ type: 'ArrayExpression', elements: node.arguments }]),
          })];
        }
      }
      // obj[key](...) 는 this가 obj여야 하므로 멤버 형태를 유지 (호출되는 값이 location일 수는 없다)
      node.callee = callee.type === 'MemberExpression' ? transformMember(callee, scope, state, ctx, 'callee') : t(callee);
      return node;
    }

    case 'TaggedTemplateExpression':
      node.tag = node.tag.type === 'MemberExpression' ? transformMember(node.tag, scope, state, ctx, 'callee') : t(node.tag);
      node.quasi = t(node.quasi);
      return node;

    case 'Property': {
      // 객체 리터럴의 속성 (패턴 안의 Property는 transformPattern이 처리)
      if (node.computed) node.key = t(node.key);
      const value = t(node.value);
      if (node.shorthand && value !== node.value) node.shorthand = false; // { location } -> { location: __proxy.location }
      node.value = value;
      return node;
    }

    case 'MethodDefinition':
    case 'PropertyDefinition':
      if (node.computed) node.key = t(node.key);
      if (node.value) node.value = t(node.value);
      return node;

    case 'VariableDeclarator':
      node.id = transformPattern(node.id, scope, state, 'binding');
      node.init = t(node.init);
      return node;

    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const f = scopeOf(node);
      node.params = node.params.map((p) => transformPattern(p, f, state, 'binding'));
      if (node.body.type === 'BlockStatement') node.body.body = node.body.body.map((s) => t(s, f, { inChain: false }));
      else node.body = t(node.body, f, { inChain: false });
      return node;
    }

    case 'ClassDeclaration':
    case 'ClassExpression': {
      const c = scopeOf(node);
      if (node.superClass) node.superClass = t(node.superClass, c);
      node.body.body = node.body.body.map((m) => t(m, c));
      return node;
    }

    case 'CatchClause': {
      const c = scopeOf(node);
      if (node.param) node.param = transformPattern(node.param, c, state, 'binding');
      node.body = t(node.body, c);
      return node;
    }

    case 'ForInStatement':
    case 'ForOfStatement': {
      const s = scopeOf(node);
      node.left = node.left.type === 'VariableDeclaration' ? t(node.left, s) : transformPattern(node.left, s, state, 'assign');
      node.right = t(node.right, s);
      node.body = t(node.body, s);
      return node;
    }

    case 'LabeledStatement':
      node.body = t(node.body);
      return node;
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'MetaProperty':
    case 'Super':
    case 'ThisExpression':
    case 'Literal':
    case 'PrivateIdentifier':
      return node;

    case 'ImportDeclaration':
      node.source = rewriteSpecifier(node.source, state);
      return node;
    case 'ExportNamedDeclaration':
      if (node.declaration) node.declaration = t(node.declaration);
      if (node.source) node.source = rewriteSpecifier(node.source, state);
      return node;
    case 'ExportAllDeclaration':
      node.source = rewriteSpecifier(node.source, state);
      return node;
    case 'ImportExpression':
      // 문자열 리터럴만 정적으로 바꾼다 (동적인 값은 서비스 워커가 처리)
      node.source = node.source.type === 'Literal' ? rewriteSpecifier(node.source, state) : t(node.source);
      if (node.options) node.options = t(node.options);
      return node;
  }

  // 그 밖의 노드: 블록 스코프를 만드는 노드면 스코프를 바꿔서 자식 순회
  const s = scopeOf(node);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) node[key] = v.map((c) => (isNode(c) ? t(c, s) : c));
    else if (isNode(v)) node[key] = t(v, s);
  }
  return node;
}

/** 멤버 식의 객체와 (계산된) 키만 변환하고 멤버 형태는 유지. 키 식은 체인 밖과 같이 변환 (tKey) */
function walkMemberParts(node, t, tKey = t) {
  node.object = t(node.object);
  if (node.computed) node.property = tKey(node.property);
}

/**
 * @param {'get'|'callee'} mode callee: 호출 대상이라 this 유지를 위해 obj[key]를 __proxy.get으로 바꾸지 않음
 */
function transformMember(node, scope, state, ctx, mode) {
  const t = (n) => transform(n, scope, state, ctx);
  const tKey = (n) => transform(n, scope, state, { inChain: false });
  const changed = (n) => {
    state.changed = true;
    return n;
  };
  const name = staticMemberName(node);
  const obj = node.object;

  if (!ctx.inChain && name && SPECIAL.has(name) && obj.type !== 'Super' && !isIdent(obj, '__proxy')) {
    // window.location, document.location, self.top ... -> __proxy.xxx
    if (isGlobalObject(obj, scope, name === 'location')) return changed(proxyMember(name));
    // 그 밖의 x.location: x가 무엇인지 런타임에 확인 (iframe.contentWindow.location 등)
    // x.top / x.parent 는 rect.top, node.parent 같은 흔한 속성이 대부분이라 건드리지 않는다
    if (name === 'location') return changed(callExpr(proxyMember('get'), [t(obj), literal(name)]));
  }
  if (!ctx.inChain && mode === 'get' && node.computed && name === null && keyMayBeSpecial(node.property) && obj.type !== 'Super') {
    // window['loc' + 'ation'] 같은 계산된 접근
    return changed(callExpr(proxyMember('get'), [t(obj), tKey(node.property)]));
  }
  walkMemberParts(node, t, tKey);
  return node;
}

/**
 * 패턴(구조 분해, 함수 매개변수 등) 변환
 * @param {'binding'|'assign'} mode binding: 선언(이름은 지역 변수) / assign: 대입 대상(기존 변수/속성)
 */
function transformPattern(p, scope, state, mode) {
  if (!p) return p;
  const t = (n) => transform(n, scope, state, { inChain: false });
  switch (p.type) {
    case 'Identifier':
      if (mode === 'assign' && p.name === 'location' && !isShadowed('location', scope)) {
        state.changed = true;
        return proxyMember('location');
      }
      return p;
    case 'MemberExpression': {
      // 대입 대상인 멤버 ([a.b] = arr). 정적 window.location 만 바꾼다
      const name = staticMemberName(p);
      if (name === 'location' && isGlobalObject(p.object, scope, true)) {
        state.changed = true;
        return proxyMember('location');
      }
      walkMemberParts(p, t);
      return p;
    }
    case 'ObjectPattern':
      for (const prop of p.properties) {
        if (prop.type === 'RestElement') {
          prop.argument = transformPattern(prop.argument, scope, state, mode);
          continue;
        }
        if (prop.computed) prop.key = t(prop.key);
        prop.value = transformPattern(prop.value, scope, state, mode);
        // { location } / { location = 1 } 의 대상이 멤버 식으로 바뀌면 축약형으로 쓸 수 없다
        const target = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
        if (prop.shorthand && target.type !== 'Identifier') prop.shorthand = false;
      }
      return p;
    case 'ArrayPattern':
      p.elements = p.elements.map((el) => transformPattern(el, scope, state, mode));
      return p;
    case 'AssignmentPattern':
      p.left = transformPattern(p.left, scope, state, mode);
      p.right = t(p.right);
      return p;
    case 'RestElement':
      p.argument = transformPattern(p.argument, scope, state, mode);
      return p;
    default:
      return t(p);
  }
}
