// WebSocket 중계: 브라우저 <-> 프록시(/__proxy/ws?url=...) <-> 원본 ws(s):// 서버
//
// 순서: 원본 서버에 먼저 연결하고, 성공하면 그때 브라우저 쪽 업그레이드를 완료한다.
//  - 원본이 고른 서브프로토콜(Sec-WebSocket-Protocol)을 브라우저에 그대로 돌려줄 수 있고
//  - 원본이 거부하면(403 등) 그 상태코드를 브라우저에 그대로 전달할 수 있다.
import { WebSocket, WebSocketServer } from 'ws';
import { decodeWsProxyRequest } from '../shared/url.js';
import { readCookieHeader, SESSION_COOKIE } from './cookies.js';

const debug = process.env.DEBUG === '1' ? (...a) => console.log('[ws]', ...a) : () => {};

export const WS_HANDSHAKE_TIMEOUT_MS = 15_000;

// 브라우저 쪽 업그레이드: 원본이 고른 서브프로토콜을 그대로 쓴다 (요청 객체에 붙여 둔 값)
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (_protocols, req) => req.proxySelectedProtocol || false,
});

/** 쿠키 저장소는 http(s) URL 기준이므로 ws -> http, wss -> https 로 본다 (RFC 6265bis) */
export function cookieUrlFor(wsUrl) {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  return u.href;
}

/** 원본 서버로 보낼 핸드셰이크 헤더 */
export function buildWsHeaders(req, target, pageOrigin, jar) {
  const headers = {};
  if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];
  if (req.headers['accept-language']) headers['accept-language'] = req.headers['accept-language'];
  // Origin: 연결을 연 페이지의 원본 origin (hook.js가 URL에 실어 보냄). 모르면 대상 서버와 같은 origin으로 본다
  headers.origin = pageOrigin ?? new URL(cookieUrlFor(target)).origin;
  const cookie = jar?.getCookieString(cookieUrlFor(target));
  if (cookie) headers.cookie = cookie;
  return headers;
}

/** HTTP 응답을 쓰고 소켓을 닫는다 (업그레이드 전 단계의 실패) */
function rejectUpgrade(socket, status, message) {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'X-Proxy-Error: 1\r\n' +
      'Connection: close\r\n\r\n' +
      body,
  );
}

// 1005(상태 없음), 1006(비정상 종료), 1015(TLS 실패)는 close()에 직접 넣을 수 없는 코드
const canSendCloseCode = (code) => (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);

function closeOther(ws, code, reason) {
  if (ws.readyState === WebSocket.OPEN) {
    if (canSendCloseCode(code)) ws.close(code, reason);
    else ws.close();
  } else if (ws.readyState === WebSocket.CONNECTING) {
    ws.terminate();
  }
}

/**
 * http.Server 의 'upgrade' 이벤트 처리
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {{ cookieStore?: import('./cookies.js').CookieStore, handshakeTimeoutMs?: number }} [options]
 */
export function handleWsUpgrade(req, socket, head, { cookieStore, handshakeTimeoutMs = WS_HANDSHAKE_TIMEOUT_MS } = {}) {
  const parsed = decodeWsProxyRequest(req.url);
  if (!parsed) return rejectUpgrade(socket, 400, 'Bad Request');
  const { url: target, origin: pageOrigin } = parsed;

  // 세션: 업그레이드 응답에는 Set-Cookie를 붙이기 어려우므로, 세션이 없으면 쿠키 없이 연결한다
  const sid = readCookieHeader(req.headers.cookie)[SESSION_COOKIE];
  const jar = sid && cookieStore?.has(sid) ? cookieStore.get(sid) : null;

  const protocols = (req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  debug('연결', target, protocols.length ? `protocols=${protocols}` : '');
  let upstream;
  try {
    upstream = new WebSocket(target, protocols, {
      headers: buildWsHeaders(req, target, pageOrigin, jar),
      handshakeTimeout: handshakeTimeoutMs,
      followRedirects: false,
    });
  } catch (err) {
    return rejectUpgrade(socket, 400, 'Bad Request');
  }

  // 업그레이드 전 단계의 결과(성공/거부/실패)는 한 번만 처리한다
  let settled = false;
  const settle = () => {
    if (settled) return false;
    settled = true;
    socket.off('close', onSocketClose);
    return true;
  };
  // 브라우저가 기다리다 먼저 끊으면 원본 연결도 중단
  const onSocketClose = () => {
    settled = true;
    upstream.terminate();
  };
  socket.once('close', onSocketClose);
  socket.on('error', () => upstream.terminate());

  // 원본 핸드셰이크 응답의 Set-Cookie 저장 (3단계 규칙)
  upstream.once('upgrade', (res) => {
    const setCookie = res.headers['set-cookie'];
    if (jar && setCookie) for (const sc of [].concat(setCookie)) jar.setCookie(sc, cookieUrlFor(target));
  });

  // 원본이 업그레이드를 거부: 상태코드를 그대로 전달
  upstream.once('unexpected-response', (_request, res) => {
    res.resume();
    if (settle()) {
      debug('원본이 거부', res.statusCode, target);
      rejectUpgrade(socket, res.statusCode, res.statusMessage || 'Upstream Rejected');
    }
    upstream.terminate();
  });

  // 'error' 리스너가 없으면 프로세스가 죽으므로 항상 on 으로 둔다 (연결 후 에러는 relay가 처리)
  upstream.on('error', (err) => {
    if (!settle()) return;
    // 연결 단계 실패(DNS, 연결 거부, 시간 초과): 프록시 자체 에러
    const timedOut = /timed? ?out/i.test(err.message);
    debug('원본 연결 실패', target, err.code || err.message);
    rejectUpgrade(socket, timedOut ? 504 : 502, timedOut ? 'Gateway Timeout' : 'Bad Gateway');
  });

  upstream.once('open', () => {
    if (!settle() || socket.destroyed) {
      upstream.terminate();
      return;
    }
    req.proxySelectedProtocol = upstream.protocol;
    wss.handleUpgrade(req, socket, head, (client) => relay(client, upstream, target));
  });
}

/** 양방향 중계. 텍스트/바이너리 구분 유지, 한쪽이 닫히면 다른 쪽도 닫는다 */
function relay(client, upstream, target) {
  debug('중계 시작', target);
  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  client.on('close', (code, reason) => {
    debug('브라우저 종료', code, target);
    closeOther(upstream, code, reason);
  });
  upstream.on('close', (code, reason) => {
    debug('원본 종료', code, target);
    closeOther(client, code, reason);
  });
  // 에러 뒤에는 close 이벤트가 오지만, 상대편이 오래 기다리지 않도록 바로 끊는다
  client.on('error', () => upstream.terminate());
  upstream.on('error', () => client.terminate());
}

/** /__proxy/ws 가 아닌 업그레이드 요청 (hook이 없는 페이지가 localhost로 직접 연결 등) */
export function rejectUnknownUpgrade(socket) {
  rejectUpgrade(socket, 404, 'Not Found');
}
