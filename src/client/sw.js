// 프록시 서비스 워커 (scope: /, 모듈 워커)
//
// 페이지 JS가 만드는 요청(fetch, XHR, 동적으로 넣은 <img>/<script>, import() 등)은
// HTML 재작성으로 잡을 수 없다. 이 워커가 모든 요청을 가로채 프록시 경로(/p/...)로 바꾼다.
//
// URL 변환 규칙은 서버와 같은 url.js(/__proxy/url.js)를 공유한다.
import { rewriteRequestUrl, PROXY_PREFIX, CLIENT_PREFIX } from './url.js';

const proxyOrigin = self.location.origin;

// 새 버전이 설치되면 기다리지 않고 바로 활성화하고, 열려 있는 페이지도 즉시 제어한다
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
// 활성 워커가 있는데 제어받지 못하는 페이지(강력 새로고침 등)가 요청하면 다시 claim
self.addEventListener('message', (event) => {
  if (event.data === 'claim') event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 이미 프록시 경로면 손대지 않는다 (respondWith 없이 브라우저 기본 동작)
  if (url.origin === proxyOrigin && (url.pathname.startsWith(PROXY_PREFIX) || url.pathname.startsWith(CLIENT_PREFIX))) {
    return;
  }

  if (req.mode === 'navigate') {
    // 페이지 이동(location.href = '/login', 폼 전송 등): 응답을 대신 받아 주면 문서 URL이
    // localhost/login 으로 남아 이후 상대 URL이 다 깨진다. 프록시 URL로 리다이렉트해서
    // 주소창부터 /p/... 가 되게 한다. 307은 POST 메서드와 바디를 유지한다.
    // 내비게이션 요청에는 clientId가 없으므로 referrer(이동 전 페이지)로 원본 사이트를 판단한다.
    const target = rewriteRequestUrl(req.url, { proxyOrigin, referrer: req.referrer });
    if (target) event.respondWith(Response.redirect(target, 307));
    return;
  }

  if (url.origin !== proxyOrigin) {
    // 다른 origin으로 가는 요청은 요청한 페이지와 무관하게 그 URL을 그대로 프록시
    const target = rewriteRequestUrl(req.url, { proxyOrigin });
    if (target) event.respondWith(forward(req, target));
    return;
  }

  event.respondWith(handleSameOrigin(event));
});

// localhost 기준으로 해석된 루트 상대 요청: 요청한 페이지의 원본 사이트를 알아내 변환
async function handleSameOrigin(event) {
  const req = event.request;
  const client = event.clientId ? await self.clients.get(event.clientId) : null;
  const target = rewriteRequestUrl(req.url, { proxyOrigin, clientUrl: client?.url, referrer: req.referrer });
  return target ? forward(req, target) : fetch(req);
}

// 원래 요청의 메서드/헤더/바디/credentials 등을 유지한 채 URL만 바꿔 보낸다
async function forward(req, target) {
  const init = {
    method: req.method,
    headers: req.headers,
    credentials: req.credentials,
    cache: req.cache,
    redirect: req.redirect,
    referrerPolicy: req.referrerPolicy,
    keepalive: req.keepalive,
    signal: req.signal,
    // 바뀐 URL은 프록시와 같은 origin. 'navigate'/'no-cors'는 생성자에서 쓸 수 없거나 응답을 불투명하게 만든다
    mode: 'same-origin',
    // integrity는 넘기지 않는다: 프록시가 HTML/CSS 내용을 바꾸므로 해시가 맞지 않음
  };
  // Referer는 서버(headers.js)가 원본 URL로 되돌린다. 프록시 origin의 URL일 때만 지정할 수 있다
  if (req.referrer.startsWith(proxyOrigin + '/')) init.referrer = req.referrer;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // 스트리밍 요청 바디는 HTTP/1.1에서 지원되지 않으므로 한 번에 읽어 넘긴다
    init.body = await req.blob();
  }
  return fetch(new Request(target, init));
}
