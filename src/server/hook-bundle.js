// /__proxy/hook.js 응답 = src/shared/url.js + src/client/hook.js 를 하나의 즉시 실행 함수로 합친 것.
//
// hook.js 는 HTML <head> 맨 앞에서 다른 스크립트보다 먼저 "동기로" 실행되어야 하므로
// 모듈 스크립트(항상 지연 실행)를 쓸 수 없다. 대신 url.js 의 export 키워드만 지워
// 같은 함수 스코프에 넣는다. URL 규칙의 소스는 여전히 url.js 한 곳이다.
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../../', import.meta.url);

/** ESM 소스에서 export 키워드를 지워 일반 스크립트 본문으로 만든다 (url.js처럼 import가 없는 파일 전용) */
export function stripModuleSyntax(source) {
  const out = source.replace(/^export\s+(?=(?:const|let|var|function|class|async)\b)/gm, '');
  if (/^\s*(?:import|export)\b/m.test(out)) {
    throw new Error('일반 스크립트로 바꿀 수 없는 import/export 구문이 남아 있습니다');
  }
  return out;
}

export async function buildHookScript() {
  const [url, hook] = await Promise.all([
    readFile(new URL('src/shared/url.js', ROOT), 'utf8'),
    readFile(new URL('src/client/hook.js', ROOT), 'utf8'),
  ]);
  return `(function () {
'use strict';
// ---- src/shared/url.js ----
${stripModuleSyntax(url)}
// ---- src/client/hook.js ----
${hook}
})();
`;
}
