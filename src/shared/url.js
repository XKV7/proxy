// 프록시 URL 규칙의 단일 출처. 서버(Node)와 브라우저가 모두 import 하므로
// 전역 URL 외의 런타임 의존성을 두지 않는다.
//
//   원본:   https://example.com/a/b?x=1
//   프록시: /p/https://example.com/a/b?x=1

export const PROXY_PREFIX = '/p/';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 원본 절대 URL -> 프록시 경로.
 * @param {string} url 원본 절대 URL
 * @returns {string} 예) "/p/https://example.com/"
 * @throws {TypeError} 절대 URL이 아니거나 http(s)가 아닌 경우
 */
export function encodeProxyUrl(url) {
  const parsed = parseHttpUrl(url);
  if (!parsed) throw new TypeError(`프록시할 수 없는 URL: ${url}`);
  return PROXY_PREFIX + parsed.href;
}

/**
 * 프록시 경로 -> 원본 절대 URL.
 * 경로 뒤의 쿼리스트링도 원본 URL의 일부로 취급한다.
 * @param {string} path 예) "/p/https://example.com/a?x=1"
 * @returns {string|null} 원본 URL(정규화된 href). 규칙에 맞지 않으면 null.
 */
export function decodeProxyUrl(path) {
  if (typeof path !== 'string' || !path.startsWith(PROXY_PREFIX)) return null;
  let raw = path.slice(PROXY_PREFIX.length);
  // 일부 클라이언트/중간 장비가 경로의 "//"를 "/"로 합치는 경우 복원
  raw = raw.replace(/^(https?):\/(?!\/)/i, '$1://');
  const parsed = parseHttpUrl(raw);
  return parsed ? parsed.href : null;
}

/**
 * 상대 경로를 기준 URL에 대해 절대 URL로 만든다.
 * @param {string} relative 상대/절대 URL
 * @param {string} base 기준 절대 URL
 * @returns {string|null} 절대 URL. 해석 불가능하면 null.
 */
export function resolve(relative, base) {
  try {
    return new URL(relative, base).href;
  } catch {
    return null;
  }
}

/**
 * 페이지 안의 URL 값(상대/절대/프로토콜 상대)을 프록시 경로로 바꾼다.
 * 프록시 대상이 아닌 값은 원래 문자열을 그대로 돌려준다:
 *   빈 값, "#frag"(같은 문서 참조), data:, javascript:, mailto:, blob:, about: 등
 * @param {string} value 원본 문서에 적힌 URL
 * @param {string} base 기준 절대 URL (문서 URL 또는 <base href>)
 * @returns {string}
 */
export function proxify(value, base) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#')) return value;
  const absolute = resolve(trimmed, base);
  if (!absolute || !parseHttpUrl(absolute)) return value;
  return encodeProxyUrl(absolute);
}

/**
 * Refresh 헤더 / <meta http-equiv="refresh"> 의 content 값 안의 URL을 프록시 경로로 바꾼다.
 * 형식 예) "5", "0; url=/next", "3;URL='https://a.com/'"
 * @param {string} content
 * @param {string} base
 * @returns {string}
 */
export function proxifyRefresh(content, base) {
  if (typeof content !== 'string') return content;
  const m = /^(\s*[\d.]*\s*[;,]?\s*(?:url\s*=\s*)?)(['"]?)(.*?)\2(\s*)$/is.exec(content);
  if (!m || !m[3]) return content;
  const [, prefix, quote, url, tail] = m;
  return prefix + quote + proxify(url, base) + quote + tail;
}

function parseHttpUrl(value) {
  try {
    const u = new URL(value);
    return ALLOWED_PROTOCOLS.has(u.protocol) ? u : null;
  } catch {
    return null;
  }
}
