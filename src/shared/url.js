// 프록시 URL 규칙의 단일 출처. 서버(Node)와 브라우저가 모두 import 하므로
// 전역 URL 외의 런타임 의존성을 두지 않는다.
//
//   원본:   https://example.com/a/b?x=1
//   프록시: /p/https://example.com/a/b?x=1

export const PROXY_PREFIX = '/p/';
// 프록시 자체의 클라이언트 자원 (sw.js, hook.js 등). 원본 사이트 요청으로 바꾸지 않는다.
export const CLIENT_PREFIX = '/__proxy/';

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

/**
 * 서비스 워커가 가로챈 요청 URL -> 프록시 URL (절대 URL). 바꿀 필요가 없으면 null.
 *
 * - 프록시 origin의 /p/... , /__proxy/... : 이미 프록시 경로 -> null
 * - 프록시 origin의 그 밖의 경로 (예: 페이지 JS의 fetch('/api/x')가 localhost 기준으로 해석된 것)
 *     -> 요청을 보낸 페이지(clientUrl, 없으면 referrer)의 원본 사이트 기준으로 해석
 *     -> 원본 페이지를 알 수 없으면(시작 페이지 등) null
 * - 다른 origin의 http(s) 요청 (예: fetch('https://api.site.com/x')) -> 그 URL을 프록시 경로로
 *
 * @param {string} requestUrl 브라우저가 해석한 요청 URL
 * @param {{ proxyOrigin: string, clientUrl?: string|null, referrer?: string|null }} context
 * @returns {string|null}
 */
export function rewriteRequestUrl(requestUrl, { proxyOrigin, clientUrl, referrer } = {}) {
  let req;
  try {
    req = new URL(requestUrl);
  } catch {
    return null;
  }
  if (req.origin === proxyOrigin) {
    if (req.pathname.startsWith(PROXY_PREFIX) || req.pathname.startsWith(CLIENT_PREFIX)) return null;
    const page = originalPageUrl(clientUrl, proxyOrigin) ?? originalPageUrl(referrer, proxyOrigin);
    if (!page) return null;
    return proxyOrigin + encodeProxyUrl(resolve(req.pathname + req.search, page));
  }
  if (!parseHttpUrl(req.href)) return null;
  return proxyOrigin + encodeProxyUrl(req.href);
}

/** 프록시 페이지의 URL(http://localhost:8080/p/https://site/page) -> 원본 URL. 아니면 null */
function originalPageUrl(url, proxyOrigin) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.origin === proxyOrigin ? decodeProxyUrl(u.pathname + u.search) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 브라우저(hook.js) 쪽에서 쓰는 변환. 페이지 JS가 넘기는 값은 원본 URL일 수도,
// 이미 프록시 URL일 수도(예: 프록시가 바꿔 둔 a.href 를 다시 읽어 대입) 있다.
// ---------------------------------------------------------------------------

/**
 * 페이지 JS가 넘긴 URL -> 프록시 경로. 이미 프록시 경로면 그대로 둔다(이중 변환 방지).
 * @param {*} value 문자열 또는 URL 객체 등 (String()으로 변환)
 * @param {string} base 원본 기준 URL (원본 문서 URL 또는 <base href>)
 * @param {string} proxyOrigin 예) "http://localhost:8080"
 * @returns {string}
 */
export function proxifyClientUrl(value, base, proxyOrigin) {
  const s = String(value);
  const trimmed = s.trim();
  let path = null;
  if (trimmed.startsWith(proxyOrigin + '/')) path = trimmed.slice(proxyOrigin.length);
  else if (trimmed.startsWith('/') && !trimmed.startsWith('//')) path = trimmed;
  if (path !== null) {
    // /__proxy/... 또는 /p/<올바른 URL> 이면 이미 프록시 경로.
    // /p/123 처럼 디코딩이 안 되는 것은 원본 사이트의 경로로 본다.
    if (path.startsWith(CLIENT_PREFIX) || decodeProxyUrl(path.split('#')[0])) return trimmed;
    // 프록시 origin 기준으로 해석된 루트 상대 경로 -> 원본 사이트의 같은 경로
    return proxify(path, base);
  }
  return proxify(s, base);
}

/**
 * WebSocket URL -> 프록시 WebSocket 엔드포인트 (ws://localhost:PORT/__proxy/ws?url=...)
 * http(s) URL과 상대 URL도 허용한다 (최신 WebSocket 명세와 같음).
 * @param {*} value 페이지 JS가 넘긴 URL
 * @param {string} base 원본 기준 URL
 * @param {string} proxyOrigin 예) "http://localhost:8080" (https면 wss로)
 * @param {string} [pageOrigin] 연결을 여는 페이지의 원본 origin. 서버가 Origin 헤더를 원본 기준으로 맞추는 데 쓴다
 *   (브라우저는 WebSocket 핸드셰이크에 Referer를 보내지 않으므로 URL에 실어 보낸다)
 * @returns {string|null} 변환할 수 없으면 null (호출한 쪽이 원래 값으로 네이티브 에러를 내게 둔다)
 */
export function encodeWsProxyUrl(value, base, proxyOrigin, pageOrigin) {
  let u;
  try {
    u = new URL(String(value), base);
  } catch {
    return null;
  }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
  u.hash = '';
  const proxy = new URL(proxyOrigin);
  const wsOrigin = (proxy.protocol === 'https:' ? 'wss://' : 'ws://') + proxy.host;
  const origin = pageOrigin ? `&origin=${encodeURIComponent(pageOrigin)}` : '';
  return `${wsOrigin}${CLIENT_PREFIX}ws?url=${encodeURIComponent(u.href)}${origin}`;
}

/**
 * 프록시 WebSocket 요청 경로 -> 원본 ws(s) URL
 * @param {string} pathAndQuery 예) "/__proxy/ws?url=wss%3A%2F%2Fexample.com%2Fsocket"
 * @returns {string|null}
 */
export function decodeWsProxyUrl(pathAndQuery) {
  return decodeWsProxyRequest(pathAndQuery)?.url ?? null;
}

/**
 * 프록시 WebSocket 요청 경로 -> { url: 원본 ws(s) URL, origin: 페이지 원본 origin 또는 null }
 * @returns {{ url: string, origin: string|null } | null}
 */
export function decodeWsProxyRequest(pathAndQuery) {
  try {
    const u = new URL(pathAndQuery, 'http://proxy.invalid');
    if (u.pathname !== `${CLIENT_PREFIX}ws`) return null;
    const target = new URL(u.searchParams.get('url'));
    if (target.protocol !== 'ws:' && target.protocol !== 'wss:') return null;
    let origin = null;
    const o = u.searchParams.get('origin');
    if (o) {
      const parsed = new URL(o);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin;
    }
    return { url: target.href, origin };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML 속성 (서버 html.js와 브라우저 hook.js가 공유)
// ---------------------------------------------------------------------------

// 값 하나가 URL인 속성. data 는 <object> 에서만 URL이다.
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster']);
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);

/** 이 요소의 이 속성이 URL(또는 srcset)을 담는가. tag/attr는 소문자 */
export function isUrlAttribute(tag, attr) {
  return URL_ATTRS.has(attr) || SRCSET_ATTRS.has(attr) || (attr === 'data' && tag === 'object');
}

/**
 * 속성 값을 변환한다. URL 속성이 아니면 그대로.
 * @param {string} tag 소문자 태그 이름
 * @param {string} attr 소문자 속성 이름 (네임스페이스 접두사 제외)
 * @param {string} value
 * @param {(url: string) => string} convert URL 하나를 바꾸는 함수
 */
export function rewriteAttribute(tag, attr, value, convert) {
  if (SRCSET_ATTRS.has(attr)) return rewriteSrcset(value, convert);
  if (URL_ATTRS.has(attr) || (attr === 'data' && tag === 'object')) return convert(value);
  return value;
}

/**
 * srcset = "url 1x, url 2x" / "url 480w, url 800w"
 * URL 안에 쉼표가 있을 수 있어(data: URL 등) 단순 split 대신 명세의 파싱 방식을 따른다.
 * @param {string} value
 * @param {string | ((url: string) => string)} baseOrConvert 기준 URL(-> proxify) 또는 변환 함수
 */
export function rewriteSrcset(value, baseOrConvert) {
  const convert = typeof baseOrConvert === 'function' ? baseOrConvert : (u) => proxify(u, baseOrConvert);
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  const candidates = [];
  const s = value;
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (isSpace(s[i]) || s[i] === ',')) i++;
    if (i >= s.length) break;
    const start = i;
    while (i < s.length && !isSpace(s[i])) i++;
    let url = s.slice(start, i);
    let descriptors = '';
    if (/,+$/.test(url)) {
      url = url.replace(/,+$/, '');
    } else {
      const dStart = i;
      let depth = 0;
      while (i < s.length) {
        const c = s[i];
        if (c === '(') depth++;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if (c === ',' && depth === 0) break;
        i++;
      }
      descriptors = s.slice(dStart, i).trim();
    }
    const next = convert(url);
    candidates.push(descriptors ? `${next} ${descriptors}` : next);
  }
  return candidates.join(', ');
}

/**
 * <script type="..."> -> 'classic' | 'module' | null(JS가 아님: JSON, JSON-LD, importmap, 템플릿 등)
 * @param {string|undefined|null} type type 속성 값 (없으면 undefined/null)
 */
export function classifyScriptType(type) {
  const t = (type ?? '').trim().toLowerCase();
  if (t === '') return 'classic';
  if (t === 'module') return 'module';
  // HTML 명세의 JavaScript MIME 타입 목록 (매개변수 없는 형태)
  if (/^(?:text|application)\/(?:x-)?(?:java|ecma)script$|^text\/(?:jscript|livescript)$|^text\/javascript1\.[0-5]$/.test(t)) {
    return 'classic';
  }
  return null;
}

/** onclick, onload 같은 이벤트 핸들러 속성인가 */
export function isEventHandlerAttribute(name) {
  return name.length > 2 && name.startsWith('on');
}

function parseHttpUrl(value) {
  try {
    const u = new URL(value);
    return ALLOWED_PROTOCOLS.has(u.protocol) ? u : null;
  } catch {
    return null;
  }
}
