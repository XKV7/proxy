// CSS 안의 url(...) 과 @import 를 프록시 경로로 바꾼다.
import postcss from 'postcss';
import { proxify } from '../shared/url.js';

const debug = process.env.DEBUG === '1' ? (...a) => console.log('[css]', ...a) : () => {};

// url( "..." | '...' | 따옴표 없는 값 )
const URL_FUNCTION = /\burl\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|([^)"'\s]*))\s*\)/gi;
// @import 맨 앞의 문자열 형태: @import "a.css" screen;
const LEADING_STRING = /^(\s*)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/;

/**
 * 값 문자열 안의 모든 url(...) 을 변환한다.
 * 결과는 항상 url("...") 형태. 직렬화된 URL에는 " 가 %22 로 인코딩되므로 안전하다.
 */
export function rewriteCssUrls(value, base) {
  return value.replace(URL_FUNCTION, (whole, dq, sq, bare) => {
    const raw = dq ?? sq ?? bare ?? '';
    const next = proxify(raw, base);
    return next === raw ? whole : `url("${next}")`;
  });
}

function rewriteImportParams(params, base) {
  const m = LEADING_STRING.exec(params);
  if (m) {
    const raw = m[2] ?? m[3];
    return m[1] + `"${proxify(raw, base)}"` + params.slice(m[0].length);
  }
  return rewriteCssUrls(params, base);
}

function rewriteRoot(root, base) {
  root.walkAtRules((rule) => {
    const name = rule.name.toLowerCase();
    if (name === 'charset') {
      // 응답은 항상 UTF-8로 다시 인코딩해서 보내므로 원래 선언은 의미가 없다
      rule.remove();
    } else if (name === 'import') {
      rule.params = rewriteImportParams(rule.params, base);
    } else if (name !== 'namespace' && rule.params.includes('url(')) {
      // @namespace url(...) 은 식별자일 뿐 요청 대상이 아님
      rule.params = rewriteCssUrls(rule.params, base);
    }
  });
  root.walkDecls((decl) => {
    if (decl.value.includes('url(')) decl.value = rewriteCssUrls(decl.value, base);
  });
}

/**
 * 스타일시트 전체(<style> 내용 또는 .css 파일)를 변환한다.
 * @param {string} css
 * @param {string} base 기준 절대 URL (CSS 파일 URL, 또는 <style>이면 문서의 기준 URL)
 */
export function rewriteCss(css, base) {
  try {
    const root = postcss.parse(css);
    rewriteRoot(root, base);
    return root.toString();
  } catch (err) {
    // 문법이 깨진 CSS도 브라우저는 최대한 해석하므로, url(...)만이라도 바꿔 둔다
    debug('파싱 실패, 정규식으로 대체:', base, err.reason || err.message);
    return rewriteCssUrls(css, base);
  }
}

/**
 * style="..." 속성 값(선언 목록)을 변환한다.
 */
export function rewriteInlineStyle(style, base) {
  if (!style.includes('url(')) return style;
  const open = 'a{';
  try {
    const root = postcss.parse(open + style + '}');
    if (root.nodes.length !== 1 || root.first.type !== 'rule') throw new Error('선언 목록이 아님');
    rewriteRoot(root, base);
    return root.toString().slice(open.length, -1);
  } catch (err) {
    debug('style 속성 파싱 실패, 정규식으로 대체:', err.reason || err.message);
    return rewriteCssUrls(style, base);
  }
}
