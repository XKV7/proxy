import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decodeProxyUrl, encodeProxyUrl, resolve } from '../shared/url.js';

const debug = process.env.DEBUG === '1' ? (...a) => console.log('[proxy]', ...a) : () => {};

export const DEFAULT_TIMEOUT_MS = 15_000;

// 원본 서버로 넘길 요청 헤더(소문자). 나머지(cookie, host, referer, origin,
// accept-encoding 등)는 이후 단계에서 다룬다.
const FORWARD_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'user-agent',
  'range',
  'if-range',
];

// 클라이언트로 돌려주지 않을 응답 헤더.
// content-encoding/length: fetch가 압축을 풀어 주므로 실제 바디와 맞지 않는다.
// set-cookie: 쿠키 처리는 이후 단계. 그대로 넘기면 localhost에 쿠키가 쌓인다.
const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'set-cookie',
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * /p/* 요청 처리.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ timeoutMs?: number }} [options]
 */
export async function handleProxy(req, res, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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
  let upstream;
  try {
    debug(req.method, target);
    upstream = await fetch(target, {
      method: req.method,
      headers: pickRequestHeaders(req.headers),
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
  debug(upstream.status, target);

  res.writeHead(upstream.status, buildResponseHeaders(upstream, target));

  if (!upstream.body || req.method === 'HEAD') {
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    // 헤더를 이미 보냈으므로 에러 페이지는 불가. 연결만 정리한다.
    debug('스트리밍 중단', target, err.code || err.message);
    res.destroy();
  }
}

function pickRequestHeaders(incoming) {
  const headers = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    if (incoming[name] !== undefined) headers[name] = incoming[name];
  }
  return headers;
}

function buildResponseHeaders(upstream, target) {
  const headers = {};
  for (const [name, value] of upstream.headers) {
    if (DROP_RESPONSE_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  // redirect: 'manual' 이므로 브라우저가 Location을 따라간다.
  // 프록시를 벗어나지 않도록 Location을 프록시 경로로 바꿔 준다.
  if (REDIRECT_STATUSES.has(upstream.status) && headers.location) {
    const absolute = resolve(headers.location, target);
    if (absolute) {
      try {
        headers.location = encodeProxyUrl(absolute);
      } catch {
        // http(s)가 아닌 리다이렉트(mailto: 등)는 그대로 둔다
      }
    }
  }
  return headers;
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
<p><a href="/">처음으로</a></p>
</body>
</html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
