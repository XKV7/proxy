import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PROXY_PREFIX } from '../shared/url.js';
import { handleProxy, sendError } from './proxy.js';
import { CookieStore, handleCookieApi } from './cookies.js';

const ROOT = new URL('../../', import.meta.url);

const JS = 'text/javascript; charset=utf-8';
const START_PAGE = { file: 'public/index.html', type: 'text/html; charset=utf-8' };

// 고정된 정적 파일만 제공 (경로 조작 여지를 두지 않음)
const STATIC_FILES = {
  '/': START_PAGE,
  // 프록시 페이지 안에서 "/" 로 가는 이동은 서비스 워커가 원본 사이트의 "/" 로 바꾸므로,
  // 프록시 자체 페이지(에러 페이지 등)에서 시작 페이지로 돌아올 때는 이 주소를 쓴다
  '/__proxy/': START_PAGE,
  '/__proxy/url.js': { file: 'src/shared/url.js', type: JS },
  '/__proxy/hook.js': { file: 'src/client/hook.js', type: JS },
  // 스크립트 위치(/__proxy/)보다 넓은 scope(/)로 등록하려면 이 헤더가 필요하다
  '/__proxy/sw.js': { file: 'src/client/sw.js', type: JS, headers: { 'service-worker-allowed': '/' } },
};

/**
 * @param {{ timeoutMs?: number, cookieStore?: CookieStore }} [options]
 *   cookieStore: 없으면 메모리 전용 저장소를 만든다
 */
export function createProxyServer({ timeoutMs, cookieStore = new CookieStore() } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith(PROXY_PREFIX)) {
        const jar = cookieStore.sessionFor(req, res);
        return await handleProxy(req, res, { timeoutMs, jar });
      }
      const pathname = req.url.split('?')[0];
      if (pathname === '/__proxy/cookies') {
        return await handleCookieApi(req, res, cookieStore);
      }
      const entry = STATIC_FILES[pathname];
      if (entry && (req.method === 'GET' || req.method === 'HEAD')) {
        const body = await readFile(new URL(entry.file, ROOT));
        res.writeHead(200, {
          'content-type': entry.type,
          'content-length': body.length,
          // 개발 중 수정한 클라이언트 코드(특히 서비스 워커)가 바로 반영되도록
          'cache-control': 'no-cache',
          ...entry.headers,
        });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      sendError(res, 404, '찾을 수 없음', `${req.url} 은(는) 없는 경로입니다.`);
    } catch (err) {
      console.error(err);
      sendError(res, 500, '서버 오류', err.message);
    }
  });
  server.cookieStore = cookieStore;
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT) || 8080;
  const cookieFile = process.env.COOKIE_FILE || new URL('data/cookies.json', ROOT).pathname;
  const cookieStore = new CookieStore({ file: cookieFile }).load().startAutoSave();
  // 종료할 때 마지막 변경분 저장
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      cookieStore.saveSync();
      process.exit(0);
    });
  }
  createProxyServer({ cookieStore }).listen(port, '127.0.0.1', () => {
    console.log(`프록시 실행 중: http://localhost:${port}/  (쿠키 저장 파일: ${cookieFile})`);
  });
}
