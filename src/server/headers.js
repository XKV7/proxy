// 브라우저 <-> 프록시 <-> 원본 사이트 사이에서 헤더를 변환한다.
import { decodeProxyUrl, proxify, proxifyRefresh } from '../shared/url.js';

// 원본으로 보내지 않을 요청 헤더
const DROP_REQUEST_HEADERS = new Set([
  // Host는 fetch(undici)가 대상 URL에서 정한다 -> 자동으로 원본 사이트 기준
  'host',
  // hop-by-hop: 브라우저-프록시 구간에만 의미가 있음
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  // 프록시 관련 헤더
  'proxy-authorization', 'proxy-connection', 'forwarded', 'via',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip',
  // 브라우저 쿠키(__proxy_sid 등 localhost 쿠키). 사이트 쿠키는 서버 저장소에서 따로 붙인다
  'cookie',
  // 압축 해제는 fetch가 담당. 브라우저 값(zstd 등)을 넘기면 fetch가 못 푸는 인코딩이 올 수 있다
  'accept-encoding',
  // 아래에서 원본 기준으로 다시 계산
  'origin', 'referer',
]);

// 클라이언트로 돌려주지 않을 응답 헤더
const DROP_RESPONSE_HEADERS = new Set([
  // fetch가 압축을 풀어 주므로 실제 바디와 맞지 않는다
  'content-encoding', 'content-length',
  'transfer-encoding', 'connection', 'keep-alive',
  // 사이트 쿠키는 서버 저장소(cookies.js)가 보관. 그대로 넘기면 localhost에서 사이트끼리 섞인다
  'set-cookie',
  // 보안 정책: 원본 도메인 기준으로 쓰인 정책이라 프록시 안에서는 정상 자원까지 막는다
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security',
]);

/**
 * 브라우저 요청 헤더 -> 원본으로 보낼 헤더
 * @param {import('node:http').IncomingHttpHeaders} incoming
 * @param {string} target 원본 요청 URL
 */
export function buildRequestHeaders(incoming, target) {
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (DROP_REQUEST_HEADERS.has(name) || name.startsWith('proxy-')) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }

  // Referer: http://localhost:8080/p/https://site/page -> https://site/page
  const referer = refererToOriginal(incoming.referer);
  if (referer) headers.referer = referer;

  // Origin: 요청을 보낸 페이지의 원본 origin. 알 수 없으면(Referrer-Policy 등) 대상과 같은 origin으로 본다
  if (incoming.origin !== undefined) {
    headers.origin = incoming.origin === 'null'
      ? 'null'
      : new URL(referer ?? target).origin;
  }
  return headers;
}

function refererToOriginal(referer) {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    return decodeProxyUrl(u.pathname + u.search);
  } catch {
    return null;
  }
}

/**
 * 원본 응답 헤더 -> 브라우저로 보낼 헤더
 * @param {Headers} upstreamHeaders
 * @param {string} target 원본 요청 URL (상대 Location 해석 기준)
 */
export function buildResponseHeaders(upstreamHeaders, target) {
  const headers = {};
  for (const [name, value] of upstreamHeaders) {
    if (DROP_RESPONSE_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  // redirect: 'manual' 이므로 브라우저가 Location을 따라간다 -> 프록시 밖으로 나가지 않게
  if (headers.location) headers.location = proxify(headers.location, target);
  if (headers.refresh) headers.refresh = proxifyRefresh(headers.refresh, target);
  // Link: <https://cdn/x.css>; rel=preload  -> 브라우저가 직접 받아 가지 않도록
  if (headers.link) headers.link = headers.link.replace(/<([^>]*)>/g, (_, u) => `<${proxify(u, target)}>`);
  return headers;
}
