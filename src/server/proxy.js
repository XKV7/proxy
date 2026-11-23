import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decodeProxyUrl } from '../shared/url.js';
import { refererToOriginal } from './headers.js';
import { buildRequestHeaders, buildResponseHeaders } from './headers.js';
import { decodeBody } from './charset.js';
import { rewriteHtml } from '../rewrite/html.js';
import { rewriteCss } from '../rewrite/css.js';
import { JsCache } from './js-cache.js';

const debug = process.env.DEBUG === '1' ? (...a) => console.log('[proxy]', ...a) : () => {};

export const DEFAULT_TIMEOUT_MS = 15_000;
// hook.js 의 DOCUMENT_COOKIE_HEADER 와 같은 이름
export const DOCUMENT_COOKIE_HEADER = 'x-proxy-document-cookie';

// Content-Type(MIME) -> 바디 변환기. 여기 없는 타입은 그대로 스트리밍한다.
const jsRewriter = {
  kind: 'js',
  // 외부 JS 파일: 모듈 여부는 파싱으로 판별, import 경로는 이 파일 URL 기준, Worker 대비 prelude 포함
  rewrite: (text, url, { jsCache }) => jsCache.rewrite(text, { sourceType: 'auto', base: url, prelude: true }),
};
const REWRITERS = {
  'text/html': {
    kind: 'html',
    rewrite: (text, url, { charset, cookie, jsCache }) =>
      rewriteHtml(text, url, { charset, cookie, rewriteJs: (code, opts) => jsCache.rewriteSync(code, opts) }),
  },
  'text/css': { kind: 'css', rewrite: (text, url) => rewriteCss(text, url) },
  'text/javascript': jsRewriter,
  'application/javascript': jsRewriter,
  'application/x-javascript': jsRewriter,
  'text/ecmascript': jsRewriter,
  'application/ecmascript': jsRewriter,
};

const defaultJsCache = new JsCache();

/**
 * /p/* 요청 처리.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ timeoutMs?: number, jar?: import('./cookies.js').CookieJar, jsCache?: JsCache }} [options]
 *   jar: 이 브라우저 세션의 사이트 쿠키 저장소. 없으면 쿠키를 주고받지 않는다.
 *   jsCache: JS 변환 결과 캐시. 없으면 메모리 전용 캐시를 쓴다.
 */
export async function handleProxy(req, res, { timeoutMs = DEFAULT_TIMEOUT_MS, jar, jsCache = defaultJsCache } = {}) {
  const target = decodeProxyUrl(req.url);
  if (!target) {
    return sendError(res, 400, '잘못된 URL', `프록시할 수 없는 주소입니다: ${req.url}`);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // 클라이언트가 먼저 끊으면 원본 요청도 중단
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const requestHeaders = buildRequestHeaders(req.headers, target);
  // 부분 요청(영상 탐색 등)은 압축되지 않은 원래 바이트 범위를 받아야 한다
  if (requestHeaders.range) requestHeaders['accept-encoding'] = 'identity';
  const cookie = jar?.getCookieString(target);
  if (cookie) requestHeaders.cookie = cookie;
  let upstream;
  try {
    debug(req.method, target, cookie ? `(쿠키 ${cookie.split('; ').length}개)` : '');
    upstream = await fetch(target, {
      method: req.method,
      headers: requestHeaders,
      body: hasBody ? req : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (res.destroyed) return;
    if (timedOut) {
      return sendError(res, 504, '시간 초과', `${timeoutMs / 1000}초 안에 응답이 없습니다: ${target}`);
    }
    debug('fetch 실패', target, err);
    return sendError(res, 502, '연결 실패', `${target} 에 연결할 수 없습니다. (${describeError(err)})`);
  }
  // 타임아웃은 응답 헤더 수신까지만. 바디(큰 파일, 영상)는 제한하지 않는다.
  clearTimeout(timer);

  // 원본의 Set-Cookie는 서버 저장소에만 보관 (브라우저로는 buildResponseHeaders에서 제거됨)
  const setCookies = jar ? upstream.headers.getSetCookie() : [];
  for (const setCookie of setCookies) jar.setCookie(setCookie, target);

  const headers = buildResponseHeaders(upstream.headers, target);

  // 쿠키가 바뀌었으면, 요청을 보낸 페이지의 document.cookie 새 값을 알려 준다 (hook.js가 캐시 갱신)
  const pageUrl = setCookies.length ? refererToOriginal(req.headers.referer) : null;
  if (pageUrl) headers[DOCUMENT_COOKIE_HEADER] = encodeURIComponent(jar.getCookieString(pageUrl, { http: false }));
  const contentType = upstream.headers.get('content-type');
  const rewriter = REWRITERS[mimeType(contentType)];
  debug(upstream.status, rewriter ? rewriter.kind : 'stream', target);

  if (!upstream.body || req.method === 'HEAD') {
    keepContentLength(upstream, headers);
    res.writeHead(upstream.status, headers);
    res.end();
    return;
  }

  // 206(부분 응답)은 전체 문서가 아니므로 변환하지 않는다
  if (rewriter && upstream.status !== 206) {
    let output;
    try {
      const buf = Buffer.from(await upstream.arrayBuffer());
      const { text, charset } = decodeBody(buf, contentType, rewriter.kind);
      // 이 응답의 Set-Cookie까지 반영된 값 (위에서 저장함)
      const cookie = jar ? jar.getCookieString(target, { http: false }) : '';
      output = Buffer.from(await rewriter.rewrite(text, target, { charset, cookie, jsCache }), 'utf8');
      debug('변환 완료', rewriter.kind, charset, `${buf.length}B -> ${output.length}B`);
    } catch (err) {
      if (res.destroyed) return;
      debug('변환 실패', target, err);
      return sendError(res, 502, '응답 처리 실패', `${target} 응답을 읽거나 변환하지 못했습니다. (${describeError(err)})`);
    }
    headers['content-type'] = `${mimeType(contentType)}; charset=utf-8`;
    headers['content-length'] = output.length;
    res.writeHead(upstream.status, headers);
    res.end(output);
    return;
  }

  // 원본이 압축하지 않았으면 바디가 그대로이므로 길이를 유지한다 (영상 탐색, 다운로드 진행률에 필요)
  keepContentLength(upstream, headers);
  res.writeHead(upstream.status, headers);
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    // 헤더를 이미 보냈으므로 에러 페이지는 불가. 연결만 정리한다.
    debug('스트리밍 중단', target, err.code || err.message);
    res.destroy();
  }
}

function keepContentLength(upstream, headers) {
  const encoding = upstream.headers.get('content-encoding');
  const length = upstream.headers.get('content-length');
  if (length !== null && (!encoding || encoding.toLowerCase() === 'identity')) headers['content-length'] = length;
}

function mimeType(contentType) {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

// fetch 에러는 "fetch failed" -> DOMException -> 실제 원인 처럼 cause가 중첩된다.
// 가장 깊은 원인을 보여 준다. 예) "ENOTFOUND", "ECONNREFUSED"
function describeError(err) {
  let deepest = err;
  for (let e = err; e; e = e.cause) deepest = e;
  return [deepest?.code, deepest?.message].filter(Boolean).join(': ') || String(err);
}

export function sendError(res, status, title, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; }
  p { word-break: break-all; color: #555; }
  a { color: #0366d6; }
</style>
</head>
<body>
<h1>${status} ${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/__proxy/">처음으로</a></p>
</body>
</html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    // 원본 서버의 에러 응답(상태코드 그대로 전달)과 프록시 자체 에러를 구분하는 표시
    'x-proxy-error': '1',
  });
  res.end(body);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
