# Web Proxy (학습용)

브라우저에서 URL을 입력하면 서버가 대신 요청해서 보여 주는 웹 프록시입니다.
쿠키/로그인, JS로 동적으로 불러오는 콘텐츠, WebSocket, 영상 탐색까지 프록시 안에서 동작하도록 만든
**네트워크 학습용** 프로젝트이며, 로컬(localhost)에서만 실행하는 것을 전제로 합니다.

- Node.js 20+, ESM(JavaScript), 프레임워크 없음
- 의존성: `parse5`(HTML) · `postcss`(CSS) · `acorn` + `astring`(JS) · `ws`(WebSocket), 테스트용 `jsdom`

## 실행

```bash
npm install
npm start            # http://localhost:8080/
```

| 환경변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `8080` | 서버 포트 (`127.0.0.1`에만 바인딩) |
| `DEBUG` | (없음) | `1`이면 요청/변환/쿠키/WebSocket 디버그 로그 출력 (`npm run dev`) |
| `COOKIE_FILE` | `data/cookies.json` | 사이트 쿠키 저장 파일 (10초마다, 종료 시 저장) |
| `JS_CACHE_DIR` | `data/js-cache` | JS 변환 결과 디스크 캐시 |

> `node src/server/index.js`로 직접 실행하지 말고 `npm start`를 쓰세요. `npm start`는 `--max-http-header-size=131072` 옵션을 붙여 실행합니다.
> Node 내장 fetch는 원본 응답 헤더가 이 한도(기본 16KB)를 넘으면 실패하는데, 유튜브 모바일(m.youtube.com)처럼 헤더가 큰 사이트가 있습니다.

시작 페이지에서 주소를 입력하면 `/p/<원본 URL>`로 이동합니다. 주소창에 직접 `http://localhost:8080/p/https://example.com/` 처럼 입력해도 됩니다.
시작 페이지 아래에서 현재 세션의 사이트별 쿠키 수를 보고 **쿠키 초기화**를 할 수 있습니다.
(프록시 안의 페이지에서 시작 페이지로 돌아올 때는 `/__proxy/`를 쓰세요. 프록시 페이지 안의 `/`는 원본 사이트의 `/`로 바뀝니다.)

> ⚠️ 서비스 워커는 HTTPS 또는 `localhost`에서만 동작합니다. `127.0.0.1`이 아니라 **`localhost`** 주소로 접속하세요.

### 터미널 없이 실행하기 (GitHub Codespaces, 태블릿 가능)

컴퓨터가 없거나 터미널을 쓸 수 없으면 GitHub Codespaces(브라우저에서 쓰는 클라우드 개발 환경)로 실행할 수 있습니다.
설치와 실행은 `.devcontainer/devcontainer.json` 설정으로 자동으로 진행됩니다.

1. 브라우저(태블릿은 Safari/Chrome, GitHub 앱 말고)로 이 저장소에 들어가 원하는 브랜치를 고릅니다.
2. **Code → Codespaces → Create codespace** 를 누릅니다. 처음에는 준비에 1~2분 걸립니다.
3. 편집기 화면 아래 터미널에 `프록시 실행 중`이 뜨면 프록시 시작 페이지가 새 탭으로 열립니다.
   열리지 않으면 아래 **PORTS** 탭에서 `8080 (Web Proxy)` 줄의 지구본 아이콘을 누르세요.
   주소는 `https://<이름>-8080.app.github.dev` 형태이고, 본인 GitHub 계정으로만 열리는 비공개 주소입니다.
4. 다 쓰면 `github.com/codespaces` 에서 해당 Codespace를 **Stop** 해 두면 무료 사용 시간을 아낄 수 있습니다.
   (아무 입력이 없으면 일정 시간 뒤 자동으로 멈추고, 다시 열면 서버도 다시 실행됩니다)

> 포트를 Public 으로 바꾸지 마세요. 누구나 쓸 수 있는 공개 프록시가 됩니다.

## 테스트

```bash
npm test             # node --test
```

`test/e2e.test.js`의 브라우저 테스트(동적 fetch, location 이동, 페이지 JS의 WebSocket, 미디어 탐색)는
Playwright가 설치되어 있을 때만 실행되고, 없으면 건너뜁니다.

```bash
npm i -D playwright && npx playwright install chromium
```

## 구조

```
src/
  shared/url.js        URL 규칙의 단일 출처 (서버와 브라우저가 같은 파일을 씀)
  server/
    index.js           HTTP 서버, 정적 파일, 라우팅, WebSocket 업그레이드
    proxy.js           /p/* : 원본에 fetch, Content-Type별 변환 또는 스트리밍
    headers.js         요청/응답 헤더 변환 (Referer/Origin, CSP 제거, Location 등)
    charset.js         응답 인코딩 판별 (EUC-KR 등) -> UTF-8
    cookies.js         RFC 6265 쿠키 저장소, 세션, /__proxy/cookies·session API
    ws.js              /__proxy/ws : WebSocket 양방향 중계
    js-cache.js        JS 변환 결과 캐시 (메모리 LRU + 디스크)
    hook-bundle.js     브라우저용 번들 생성 (/__proxy/hook.js, /__proxy/rewriter.js)
  rewrite/
    html.js            parse5: URL 속성, srcset, <base>, meta refresh, 인라인 CSS/JS, 이벤트 속성
    css.js             postcss: url(), @import
    js.js              acorn + astring: location/top/parent, eval, 계산된 접근, import 경로
  client/
    hook.js            브라우저 API 덮어쓰기 (모든 프록시 HTML의 <head> 맨 앞)
    sw.js              서비스 워커: JS가 만든 요청 중 놓친 것을 프록시로
public/index.html      시작 페이지
test/                  단계별 테스트 (node --test)
```

### URL 규칙

| 경로 | 뜻 |
| --- | --- |
| `/p/<원본 전체 URL>` | 프록시 요청. 예) `/p/https://example.com/a/b?x=1` |
| `/__proxy/...` | 프록시 자체 자원: `hook.js`, `sw.js`, `url.js`, `rewriter.js`, `cookies`, `session`, `ws` |

### 요청이 프록시를 거치게 하는 4겹

원본 사이트의 URL이 브라우저로 새어 나가면 페이지가 프록시를 벗어납니다. 이를 막는 장치가 단계별로 쌓여 있습니다.

1. **서버의 응답 변환** (`rewrite/html.js`, `css.js`, `headers.js`)
   HTML 속성, CSS `url()`, `Location` 헤더 등 응답에 적힌 URL을 모두 `/p/...`로 바꿉니다.
2. **서비스 워커** (`client/sw.js`)
   그래도 `localhost` 기준으로 해석된 요청(`fetch('/api')`)이나 다른 origin으로 가는 요청을 가로채
   요청한 페이지의 원본 사이트 기준으로 `/p/...`로 보냅니다. 페이지 이동은 307 리다이렉트로 주소창부터 고칩니다.
3. **hook.js** (`client/hook.js`)
   `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `window.open`, `history`,
   요소의 `src/href` 대입, `innerHTML`, `document.cookie`, `localStorage` 등을 덮어써서
   JS가 원본 주소에 있다고 믿게 하면서 요청은 프록시로 보냅니다.
4. **JS 코드 변환** (`rewrite/js.js`)
   덮어쓸 수 없는 `location`, `top`, `parent`는 코드 자체를 `__proxy.location` 등으로 바꿉니다.
   런타임 `eval`/`new Function` 코드는 `/__proxy/rewriter.js`를 필요할 때 받아 변환합니다.

### 쿠키 (서버 보관 방식)

브라우저 입장에서는 모든 사이트가 `localhost` 하나이므로 쿠키를 브라우저에 두면 사이트끼리 섞입니다.
그래서 브라우저에는 `__proxy_sid`(HttpOnly) 하나만 두고, 실제 사이트 쿠키는 서버가 세션별로 RFC 6265 규칙
(Domain/Path 매칭, 만료, Secure, HttpOnly)에 따라 보관하고 요청마다 골라 붙입니다.
`document.cookie`는 서버가 HTML에 넣어 준 초기값 + `/__proxy/cookies` API로 동기화되는 캐시입니다.

### 에러 처리

- 원본 서버의 에러(404, 500 …)는 상태코드와 본문을 그대로 전달합니다.
- 프록시 자체 에러는 에러 페이지와 `x-proxy-error: 1` 헤더로 구분합니다:
  잘못된 URL `400`, 연결 실패 `502`, 응답 헤더 15초 시간 초과 `504`.
- WebSocket: 원본이 거부하면 그 상태코드를, 연결 실패는 `502`/`504`를 업그레이드 응답으로 돌려줍니다.
- JS/CSS 파싱에 실패하면 원본을 그대로 보내고 `DEBUG=1` 로그만 남깁니다 (사이트 전체가 죽지 않도록).

## 알려진 한계

**구조적인 한계 (모든 사이트가 `localhost` 한 origin을 공유)**
- 사이트 간 격리가 없습니다. 한 사이트의 JS가 `/__proxy/cookies`로 다른 사이트의 (HttpOnly가 아닌) 쿠키를 읽거나,
  같은 `localStorage`/IndexedDB/Cache Storage에 접근할 수 있습니다. 로그인한 계정으로 신뢰하지 않는 사이트를 함께 열지 마세요.
- 모든 요청이 같은 origin이라 CORS, `SameSite`, `credentials: 'same-origin'` 같은 브라우저 보안 규칙이
  원래와 다르게(더 느슨하게) 동작합니다. `SameSite`는 저장만 하고 적용하지 않습니다.
- 원본 사이트의 경로가 `/p/...` 또는 `/__proxy/...`로 시작하면 프록시 경로와 겹칩니다.
- 공개 접미사 목록이 없어 `Domain=co.kr` 같은 쿠키를 막지 못합니다 (점 없는 최상위 도메인만 막음).

**아직 잡지 못하는 경로**
- 시작 페이지를 거치지 않고 처음 방문하면, 서비스 워커가 붙기 전에 실행된 요청 일부가 프록시를 거치지 않을 수 있습니다 (그 뒤 한 번 새로고침).
- `document.write`, `DOMParser`, `Range.createContextualFragment`로 넣은 HTML, 동적으로 넣은 CSS의 `url()`은 변환하지 않습니다
  (루트 상대/다른 origin 요청은 서비스 워커가 잡습니다).
- Worker/SharedWorker 안에는 hook이 없습니다. 요청은 서비스 워커가, `location` 등은 통과용 `__proxy`가 처리합니다.
- JS 변환: 임의 객체의 `.top`/`.parent`(예: `iframe.contentWindow.top`), 동적인 `import(name)`, `with` 문 안의 이름,
  `obj[key] += …` 같은 복합 대입, 옵셔널 체인 안의 계산된 접근은 바꾸지 않습니다.
- `javascript:` URL 안의 코드는 변환하지 않습니다.
- 다른 origin으로의 페이지 이동 중 JS 변환/hook이 놓친 것(예: `<a href>`를 JS로 읽어 다른 창에서 여는 특수한 경우)은 원본으로 나갈 수 있습니다.

**호환성/품질**
- 모듈 서비스 워커(`type: 'module'`)를 쓰므로 이를 지원하는 브라우저가 필요합니다 (Chromium에서 확인).
- JS를 다시 출력하므로 주석·서식이 사라지고 소스맵이 맞지 않습니다. 첫 변환은 1MB당 수백 ms가 걸립니다 (이후 캐시).
- 응답 인코딩 판별은 헤더/BOM/meta 기반이며, 선언이 없는 레거시 페이지는 UTF-8 → windows-1252 순으로 추정합니다.
  EUC-KR 페이지의 링크에 인코딩되지 않은 한글이 있으면 UTF-8로 퍼센트 인코딩됩니다.
- 사이트가 자체 서비스 워커를 등록하려는 경우는 지원하지 않습니다.
- HTTP/2 서버 푸시, WebTransport, WebRTC는 다루지 않습니다.
