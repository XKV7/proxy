// 브라우저로 보내는 클라이언트 스크립트 번들을 만든다. (번들러 없이, 결정적인 텍스트 변환만 사용)
//
// /__proxy/hook.js     = src/shared/url.js + src/client/hook.js
//   HTML <head> 맨 앞에서 다른 스크립트보다 먼저 "동기로" 실행되어야 하므로 모듈 스크립트(항상 지연 실행)를
//   쓸 수 없다. 대신 url.js 의 export 키워드만 지워 같은 함수 스코프에 넣는다. URL 규칙의 소스는 url.js 한 곳.
//
// /__proxy/rewriter.js = acorn + astring + src/shared/url.js + src/rewrite/js.js
//   런타임 eval / new Function 코드 변환기. 크기가 커서 hook.js가 처음 필요할 때만 받아 간다.
//   식(expression) 하나로 평가되며 결과로 { rewriteJs, rewriteFunctionArgs, ... } 를 돌려준다.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const ROOT = new URL('../../', import.meta.url);
const require = createRequire(import.meta.url);

/** ESM 소스에서 export 키워드를 지워 일반 스크립트 본문으로 만든다 (url.js처럼 import가 없는 파일 전용) */
export function stripModuleSyntax(source) {
  const out = source.replace(/^export\s+(?=(?:const|let|var|function|class|async)\b)/gm, '');
  if (/^\s*(?:import|export)\b/m.test(out)) {
    throw new Error('일반 스크립트로 바꿀 수 없는 import/export 구문이 남아 있습니다');
  }
  return out;
}

/** export 된 이름 목록 (export const/function/class 형태만) */
export function exportedNames(source) {
  return [...source.matchAll(/^export\s+(?:const|let|var|class|(?:async\s+)?function\*?)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
}

/**
 * `import { a, b as c } from 'x';` -> `const { a, b: c } = __deps['x'];` 후 export 키워드 제거.
 * 이름 붙은 import 만 지원한다 (이 프로젝트의 js.js 형태).
 */
export function esmToScript(source, depsVar = '__deps') {
  const converted = source.replace(
    /^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2;?[ \t]*$/gm,
    (_, names, _q, spec) => {
      const bindings = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '));
      return `const { ${bindings.join(', ')} } = ${depsVar}[${JSON.stringify(spec)}];`;
    },
  );
  return stripModuleSyntax(converted);
}

/** CommonJS/UMD 파일을 module.exports 를 돌려주는 식으로 */
function commonJsModule(source) {
  return `(function () {\nvar module = { exports: {} }, exports = module.exports;\n${source}\nreturn module.exports;\n})()`;
}

/** ESM 파일(import 없음)을 export 객체를 돌려주는 식으로 */
function esmModule(source) {
  return `(function () {\n'use strict';\n${stripModuleSyntax(source)}\nreturn { ${exportedNames(source).join(', ')} };\n})()`;
}

const read = (path) => readFile(new URL(path, ROOT), 'utf8');

export async function buildHookScript() {
  const [url, hook] = await Promise.all([read('src/shared/url.js'), read('src/client/hook.js')]);
  return `(function () {
'use strict';
// ---- src/shared/url.js ----
${stripModuleSyntax(url)}
// ---- src/client/hook.js ----
${hook}
})();
`;
}

let rewriterCache = null;
export async function buildRewriterScript() {
  // acorn/astring/js.js 는 서버 실행 중 바뀌지 않으므로 한 번만 만든다 (url.js/js.js 수정 시 서버 재시작)
  rewriterCache ??= (async () => {
    const [acorn, astring, url, js] = await Promise.all([
      // require 조건으로 찾으면 CommonJS/UMD 판 (dist/acorn.js, dist/astring.js) 이 나온다
      readFile(require.resolve('acorn'), 'utf8'),
      readFile(require.resolve('astring'), 'utf8'),
      read('src/shared/url.js'),
      read('src/rewrite/js.js'),
    ]);
    return `(function () {
var __deps = {};
__deps['acorn'] = ${commonJsModule(acorn)};
__deps['astring'] = ${commonJsModule(astring)};
__deps['../shared/url.js'] = ${esmModule(url)};
return (function () {
'use strict';
// ---- src/rewrite/js.js ----
${esmToScript(js)}
var api = { rewriteJs: rewriteJs, rewriteFunctionArgs: rewriteFunctionArgs, transformJs: transformJs, version: REWRITER_VERSION };
globalThis[Symbol.for('proxy.rewriter')] = api;
return api;
})();
})()
`;
  })();
  return rewriterCache;
}
