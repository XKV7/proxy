# Web Proxy (학습용)

## 목표
브라우저에서 URL을 입력하면 서버가 대신 요청해서 보여주는 웹 프록시.
쿠키/로그인, JS로 동적으로 로드되는 콘텐츠, WebSocket까지 동작하는 것이 최종 목표.
로컬(localhost)에서 실행하는 네트워크 학습용 프로젝트.

## 기술 스택
- Node.js 20+, ESM (JavaScript, TypeScript 아님)
- 서버: Node 내장 http + 내장 fetch(undici)
- HTML 파싱: parse5 / CSS: postcss / JS: acorn + astring / WebSocket: ws
- 프레임워크 없이 최소 의존성

## URL 규칙
- 프록시 경로: /p/<원본 전체 URL>  예) /p/https://example.com/a/b?x=1
- 클라이언트 측 자원: /__proxy/ 아래 (sw.js, hook.js 등)
- URL 인코딩/디코딩 로직은 src/shared/url.js 한 곳에서만 관리하고 서버/클라이언트가 공유

## 폴더 구조
```
src/
  server/      서버 (index.js, proxy.js, headers.js, charset.js, cookies.js, hook-bundle.js, ws.js)
  rewrite/     html.js, css.js, js.js (AST 변환)
  client/      sw.js, hook.js (브라우저에서 실행)
  shared/      url.js
public/        시작 페이지(index.html)
test/          단계별 테스트
```

## 작업 원칙
- 단계별로 진행. 현재 단계 범위 밖의 기능은 미리 만들지 않는다.
- 각 단계 끝에 node --test 로 돌아가는 테스트를 추가하고 전부 통과시킨다.
- 실패하는 사이트가 있으면 원인을 로그로 확인하고 근본 원인을 고친다. 사이트별 하드코딩 예외 처리 금지.
- 디버그 로그는 환경변수 DEBUG=1 일 때만 출력.
