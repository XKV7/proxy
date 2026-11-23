// 응답 헤더가 큰 사이트 (유튜브 m.youtube.com 등은 헤더가 16KB 를 넘기도 한다)
//
// Node 내장 fetch(undici)의 응답 헤더 한도는 Node 실행 옵션 --max-http-header-size (기본 16KB) 를 따른다.
// npm start / npm run dev 가 이 한도를 올려서 실행하는지, 그 옵션으로 실행하면 큰 헤더도 받는지 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const FLAG = /--max-http-header-size=(\d+)/;

test('npm start / npm run dev 는 응답 헤더 한도를 64KB 이상으로 올려서 실행', () => {
  for (const name of ['start', 'dev']) {
    const m = FLAG.exec(pkg.scripts[name]);
    assert.ok(m, `${name}: ${pkg.scripts[name]}`);
    assert.ok(Number(m[1]) >= 64 * 1024);
  }
});

// 자식 프로세스에서: 20KB 헤더를 보내는 원본 서버 + 프록시를 띄우고, 프록시를 거쳐 요청
const SCRIPT = `
import http from 'node:http';
import { createProxyServer } from ${JSON.stringify(new URL('../src/server/index.js', import.meta.url).href)};
const origin = http.createServer({ maxHeaderSize: 1 << 20 }, (req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'x-big': 'a'.repeat(20000) });
  res.end('ok');
});
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const o = await listen(origin);
const proxy = createProxyServer();
const p = await listen(proxy);
const res = await fetch('http://127.0.0.1:' + p + '/p/http://127.0.0.1:' + o + '/');
console.log(JSON.stringify({ status: res.status, body: await res.text(), big: (res.headers.get('x-big') ?? '').length }));
proxy.closeAllConnections(); proxy.close(); origin.close();
`;

async function throughProxy(nodeArgs) {
  const { stdout } = await run(process.execPath, [...nodeArgs, '--input-type=module', '-e', SCRIPT]);
  return JSON.parse(stdout.trim().split('\n').pop());
}

test('npm start 와 같은 옵션이면 16KB 를 넘는 응답 헤더도 받는다', async () => {
  const flag = FLAG.exec(pkg.scripts.start)[0];
  assert.deepEqual(await throughProxy([flag]), { status: 200, body: 'ok', big: 20000 });
});

test('기본 한도(16KB)로 실행하면 502 (이 수정이 필요했던 이유)', async () => {
  const r = await throughProxy([]);
  assert.equal(r.status, 502);
  assert.match(r.body, /UND_ERR_HEADERS_OVERFLOW/);
});
