import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PROXY_PREFIX } from '../shared/url.js';
import { handleProxy, sendError } from './proxy.js';

const ROOT = new URL('../../', import.meta.url);

// 고정된 정적 파일만 제공 (경로 조작 여지를 두지 않음)
const STATIC_FILES = {
  '/': { file: 'public/index.html', type: 'text/html; charset=utf-8' },
  '/__proxy/url.js': { file: 'src/shared/url.js', type: 'text/javascript; charset=utf-8' },
};

/**
 * @param {{ timeoutMs?: number }} [options]
 */
export function createProxyServer(options = {}) {
  return http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith(PROXY_PREFIX)) {
        return await handleProxy(req, res, options);
      }
      const pathname = req.url.split('?')[0];
      const entry = STATIC_FILES[pathname];
      if (entry && (req.method === 'GET' || req.method === 'HEAD')) {
        const body = await readFile(new URL(entry.file, ROOT));
        res.writeHead(200, { 'content-type': entry.type, 'content-length': body.length });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      sendError(res, 404, '찾을 수 없음', `${req.url} 은(는) 없는 경로입니다.`);
    } catch (err) {
      console.error(err);
      sendError(res, 500, '서버 오류', err.message);
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT) || 8080;
  createProxyServer().listen(port, '127.0.0.1', () => {
    console.log(`프록시 실행 중: http://localhost:${port}/`);
  });
}
