// 사이트 쿠키를 서버에 보관한다 (RFC 6265).
//
// 브라우저 입장에서는 모든 사이트가 localhost 한 곳이므로, 브라우저 쿠키 저장소에
// 사이트 쿠키를 그대로 두면 사이트끼리 섞인다. 그래서 브라우저에는 프록시 세션 쿠키
// (__proxy_sid) 하나만 두고, 실제 쿠키는 세션ID -> CookieJar 로 서버가 관리한다.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isIP } from 'node:net';

const debug = process.env.DEBUG === '1' ? (...a) => console.log('[cookie]', ...a) : () => {};

export const SESSION_COOKIE = '__proxy_sid';
const SESSION_MAX_AGE = 60 * 60 * 24 * 365; // 1년
const API_BODY_LIMIT = 8 * 1024;

// ---------------------------------------------------------------------------
// 날짜 파싱 (RFC 6265 5.1.1)
// ---------------------------------------------------------------------------

const DATE_DELIMITER = /[\x09\x20-\x2f\x3b-\x40\x5b-\x60\x7b-\x7e]+/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Expires 속성 값 파싱. "Wed, 21 Oct 2015 07:28:00 GMT", "Wednesday, 21-Oct-15 07:28:00 GMT" 등
 * @returns {number|null} epoch ms, 실패하면 null
 */
export function parseCookieDate(str) {
  let time, day, month, year;
  for (const token of str.split(DATE_DELIMITER)) {
    if (!token) continue;
    let m;
    if (!time && (m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D.*)?$/.exec(token))) {
      time = [+m[1], +m[2], +m[3]];
    } else if (day === undefined && (m = /^(\d{1,2})(?:\D.*)?$/.exec(token))) {
      day = +m[1];
    } else if (month === undefined && MONTHS.includes(token.slice(0, 3).toLowerCase())) {
      month = MONTHS.indexOf(token.slice(0, 3).toLowerCase());
    } else if (year === undefined && (m = /^(\d{2,4})(?:\D.*)?$/.exec(token))) {
      year = +m[1];
    }
  }
  if (year !== undefined) {
    if (year >= 70 && year <= 99) year += 1900;
    else if (year >= 0 && year <= 69) year += 2000;
  }
  if (!time || day === undefined || month === undefined || year === undefined) return null;
  const [h, mi, s] = time;
  if (day < 1 || day > 31 || year < 1601 || h > 23 || mi > 59 || s > 59) return null;
  const ms = Date.UTC(year, month, day, h, mi, s);
  // 2월 30일처럼 존재하지 않는 날짜
  if (new Date(ms).getUTCDate() !== day) return null;
  return ms;
}

// ---------------------------------------------------------------------------
// Set-Cookie 파싱 (RFC 6265 5.2)
// ---------------------------------------------------------------------------

/**
 * Set-Cookie 헤더 하나를 파싱한다. 속성 해석(기본값, 도메인 검사)은 CookieJar가 한다.
 * @returns {null | { name, value, expires?, maxAge?, domain?, path?, secure, httpOnly, sameSite? }}
 */
export function parseSetCookie(header) {
  const semi = header.indexOf(';');
  const pair = semi === -1 ? header : header.slice(0, semi);
  const eq = pair.indexOf('=');
  if (eq === -1) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;

  const cookie = { name, value, secure: false, httpOnly: false };
  const attrs = semi === -1 ? [] : header.slice(semi + 1).split(';');
  // 같은 속성이 여러 번 나오면 마지막 것이 이긴다
  for (const av of attrs) {
    const i = av.indexOf('=');
    const key = (i === -1 ? av : av.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : av.slice(i + 1).trim();
    switch (key) {
      case 'expires': {
        const t = parseCookieDate(val);
        if (t !== null) cookie.expires = t;
        break;
      }
      case 'max-age':
        if (/^-?\d+$/.test(val)) cookie.maxAge = Number(val);
        break;
      case 'domain':
        // 빈 값은 속성 자체를 무시. 앞의 "." 는 의미 없음 (.example.com == example.com)
        if (val) cookie.domain = val.replace(/^\./, '').toLowerCase();
        break;
      case 'path':
        cookie.path = val;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite': {
        const v = val.toLowerCase();
        if (v === 'strict' || v === 'lax' || v === 'none') cookie.sameSite = v;
        break;
      }
    }
  }
  return cookie;
}

// ---------------------------------------------------------------------------
// 매칭 규칙 (RFC 6265 5.1.3, 5.1.4)
// ---------------------------------------------------------------------------

/** host가 domain에 속하는가. sub.example.com 은 example.com 에 속한다. IP는 완전 일치만. */
export function domainMatch(host, domain) {
  if (host === domain) return true;
  return host.endsWith('.' + domain) && !isIP(stripBrackets(host));
}

/** 요청 경로가 쿠키 경로에 속하는가. /a 는 /a, /a/, /a/b 에 적용되지만 /ab 에는 아님. */
export function pathMatch(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** Path 속성이 없을 때의 기본 경로: 요청 경로의 마지막 "/" 앞까지 */
export function defaultPath(urlPath) {
  if (!urlPath || urlPath[0] !== '/') return '/';
  const last = urlPath.lastIndexOf('/');
  return last === 0 ? '/' : urlPath.slice(0, last);
}

const stripBrackets = (h) => h.replace(/^\[|\]$/g, '');

// IDN 등을 URL 파서와 같은 방식으로 정규화
function canonicalDomain(domain) {
  try {
    return new URL(`http://${domain}/`).hostname;
  } catch {
    return null;
  }
}

// 공개 접미사(public suffix)에 쿠키를 거는 것을 막는다.
// 전체 공개 접미사 목록은 의존성이 필요하므로, 여기서는 점이 없는 최상위 도메인(com, kr 등)만 막는다.
function isPublicSuffix(domain) {
  return !domain.includes('.') && !isIP(stripBrackets(domain));
}

// ---------------------------------------------------------------------------
// 쿠키 저장소 (RFC 6265 5.3, 5.4)
// ---------------------------------------------------------------------------

let creationSeq = 0;

export class CookieJar {
  /** @param {object[]} [cookies] 저장된 쿠키 레코드 (toJSON 결과) */
  constructor(cookies = [], onChange = () => {}) {
    /** @type {Map<string, object>} key: domain;path;name */
    this.cookies = new Map();
    for (const c of cookies) {
      this.cookies.set(keyOf(c), c);
      creationSeq = Math.max(creationSeq, c.seq ?? 0);
    }
    this.onChange = onChange;
  }

  /**
   * Set-Cookie 하나를 저장한다.
   * @param {string} header Set-Cookie 값
   * @param {string} url 응답을 보낸 원본 URL
   * @param {{ now?: number, http?: boolean }} [opts] http=false 이면 document.cookie 같은 비-HTTP API
   * @returns {boolean} 저장(또는 삭제)되었으면 true, 거부되었으면 false
   */
  setCookie(header, url, { now = Date.now(), http = true } = {}) {
    const parsed = parseSetCookie(header);
    if (!parsed) return reject('파싱 실패', header);
    const u = new URL(url);
    const host = u.hostname;

    // 만료: Max-Age가 Expires보다 우선. 0 이하는 "이미 만료"
    let expires = null; // null = 세션 쿠키
    if (parsed.maxAge !== undefined) expires = parsed.maxAge <= 0 ? 0 : now + parsed.maxAge * 1000;
    else if (parsed.expires !== undefined) expires = parsed.expires;

    // 도메인
    let domain = host;
    let hostOnly = true;
    if (parsed.domain !== undefined) {
      const d = canonicalDomain(parsed.domain);
      if (!d) return reject('잘못된 Domain', header);
      if (isPublicSuffix(d)) {
        // 공개 접미사 자체가 호스트인 경우만 host-only로 허용
        if (d !== host) return reject('공개 접미사 Domain', header);
      } else {
        if (!domainMatch(host, d)) return reject(`${host} 는 Domain=${d} 에 속하지 않음`, header);
        domain = d;
        hostOnly = false;
      }
    }

    const path = parsed.path && parsed.path[0] === '/' ? parsed.path : defaultPath(u.pathname);

    if (parsed.httpOnly && !http) return reject('비-HTTP API로 HttpOnly 설정 불가', header);

    const cookie = {
      name: parsed.name,
      value: parsed.value,
      domain,
      path,
      hostOnly,
      secure: parsed.secure,
      httpOnly: parsed.httpOnly,
      sameSite: parsed.sameSite ?? null,
      expires,
      creation: now,
      lastAccess: now,
      seq: ++creationSeq,
    };

    const key = keyOf(cookie);
    const old = this.cookies.get(key);
    if (old) {
      if (old.httpOnly && !http) return reject('비-HTTP API로 HttpOnly 쿠키 덮어쓰기 불가', header);
      // 덮어쓰기: 생성 시각(정렬 순서)은 유지
      cookie.creation = old.creation;
      cookie.seq = old.seq;
      this.cookies.delete(key);
    }
    if (expires !== null && expires <= now) {
      debug('삭제', key);
    } else {
      this.cookies.set(key, cookie);
      debug('저장', key, `=${cookie.value}`);
    }
    this.onChange();
    return true;
  }

  /**
   * 요청 URL에 보낼 쿠키 목록 (RFC 6265 5.4 순서: 긴 경로 먼저, 같으면 먼저 만든 것 먼저)
   * @param {{ now?: number, http?: boolean }} [opts] http=false 이면 HttpOnly 제외
   */
  getCookies(url, { now = Date.now(), http = true } = {}) {
    const u = new URL(url);
    const host = u.hostname;
    const secure = u.protocol === 'https:';
    const result = [];
    let expired = false;
    for (const [key, c] of this.cookies) {
      if (c.expires !== null && c.expires <= now) {
        this.cookies.delete(key);
        expired = true;
        continue;
      }
      if (c.hostOnly ? host !== c.domain : !domainMatch(host, c.domain)) continue;
      if (!pathMatch(u.pathname || '/', c.path)) continue;
      if (c.secure && !secure) continue;
      if (c.httpOnly && !http) continue;
      result.push(c);
    }
    if (expired) this.onChange();
    result.sort((a, b) => b.path.length - a.path.length || a.seq - b.seq);
    for (const c of result) c.lastAccess = now;
    return result;
  }

  /** Cookie 요청 헤더 값. 보낼 쿠키가 없으면 '' */
  getCookieString(url, opts) {
    return this.getCookies(url, opts).map((c) => `${c.name}=${c.value}`).join('; ');
  }

  get size() {
    return this.cookies.size;
  }

  /** 모든 쿠키 삭제. 지운 개수를 돌려준다 */
  clear() {
    const n = this.cookies.size;
    this.cookies.clear();
    if (n) this.onChange();
    return n;
  }

  /** 도메인별 쿠키 개수 (만료된 것 제외), 개수가 많은 순 */
  summary(now = Date.now()) {
    const byDomain = new Map();
    for (const c of this.toJSON(now)) {
      const d = byDomain.get(c.domain) ?? { domain: c.domain, count: 0, httpOnly: 0 };
      d.count++;
      if (c.httpOnly) d.httpOnly++;
      byDomain.set(c.domain, d);
    }
    return [...byDomain.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  }

  toJSON(now = Date.now()) {
    return [...this.cookies.values()].filter((c) => c.expires === null || c.expires > now);
  }
}

const keyOf = (c) => `${c.domain};${c.path};${c.name}`;
function reject(reason, header) {
  debug('거부:', reason, '|', header);
  return false;
}

// ---------------------------------------------------------------------------
// 세션 저장소: 세션ID -> CookieJar, JSON 파일로 영속화
// ---------------------------------------------------------------------------

export class CookieStore {
  /** @param {{ file?: string|null }} [options] file이 없으면 메모리에만 보관 */
  constructor({ file = null } = {}) {
    this.file = file;
    /** @type {Map<string, CookieJar>} */
    this.sessions = new Map();
    this.dirty = false;
    this.timer = null;
  }

  /** 파일에서 불러온다. 파일이 없으면 빈 상태로 시작. */
  load() {
    if (!this.file) return this;
    let data;
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[cookie] ${this.file} 를 읽지 못해 빈 저장소로 시작합니다:`, err.message);
      return this;
    }
    for (const [sid, cookies] of Object.entries(data.sessions ?? {})) {
      this.sessions.set(sid, this.#newJar(cookies));
    }
    debug(`${this.sessions.size}개 세션 로드`, this.file);
    return this;
  }

  #newJar(cookies) {
    return new CookieJar(cookies, () => {
      this.dirty = true;
    });
  }

  has(sid) {
    return this.sessions.has(sid);
  }

  get(sid) {
    return this.sessions.get(sid);
  }

  /** 새 세션을 만들고 ID를 돌려준다 */
  create() {
    const sid = randomBytes(24).toString('base64url');
    this.sessions.set(sid, this.#newJar([]));
    return sid;
  }

  /** 요청의 __proxy_sid가 가리키는 기존 세션 (새로 만들지 않음) */
  existingSession(req) {
    const sid = readCookieHeader(req.headers.cookie)[SESSION_COOKIE];
    return sid && this.sessions.has(sid) ? { sid, jar: this.sessions.get(sid) } : null;
  }

  /**
   * 요청의 __proxy_sid로 세션을 찾고, 없으면(또는 서버가 모르는 ID면) 새로 만들어
   * 응답에 Set-Cookie를 예약한다. (res.setHeader는 이후 writeHead의 헤더와 합쳐진다)
   * @returns {CookieJar}
   */
  sessionFor(req, res) {
    const sid = readCookieHeader(req.headers.cookie)[SESSION_COOKIE];
    if (sid && this.sessions.has(sid)) return this.sessions.get(sid);
    const created = this.create();
    res.setHeader('set-cookie', `${SESSION_COOKIE}=${created}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; SameSite=Lax`);
    debug('새 세션', created);
    return this.sessions.get(created);
  }

  toJSON() {
    const sessions = {};
    for (const [sid, jar] of this.sessions) {
      const cookies = jar.toJSON();
      if (cookies.length) sessions[sid] = cookies;
    }
    return { version: 1, sessions };
  }

  /** 변경이 있으면 파일에 저장 (임시 파일에 쓴 뒤 rename -> 중간에 죽어도 파일이 깨지지 않음) */
  async save() {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(tmp, JSON.stringify(this.toJSON()));
      await rename(tmp, this.file);
      debug('저장 완료', this.file);
    } catch (err) {
      this.dirty = true;
      console.error('[cookie] 저장 실패:', err.message);
    }
  }

  /** 종료 직전용 동기 저장 */
  saveSync() {
    if (!this.file || !this.dirty) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.toJSON()));
    renameSync(`${this.file}.tmp`, this.file);
    this.dirty = false;
  }

  startAutoSave(intervalMs = 10_000) {
    this.timer = setInterval(() => this.save(), intervalMs);
    this.timer.unref();
    return this;
  }

  stopAutoSave() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** 브라우저가 보낸 Cookie 헤더 -> { name: value } */
export function readCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// document.cookie 용 API: GET/POST /__proxy/cookies?url=<원본 URL>
//   GET  -> { cookie: "a=1; b=2" }  (HttpOnly 제외)
//   POST -> 바디(text/plain)는 document.cookie 에 대입하는 문자열 하나. 결과는 GET과 같음
// ---------------------------------------------------------------------------

export async function handleCookieApi(req, res, store) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const url = params.get('url');
  let target;
  try {
    target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error();
  } catch {
    return sendJson(res, 400, { error: 'url 파라미터에 http(s) 절대 URL이 필요합니다' });
  }

  const jar = store.sessionFor(req, res);
  if (req.method === 'POST') {
    let body;
    try {
      body = await readBody(req, API_BODY_LIMIT);
    } catch (err) {
      return sendJson(res, 413, { error: err.message });
    }
    jar.setCookie(body, target.href, { http: false });
  } else if (req.method !== 'GET') {
    res.setHeader('allow', 'GET, POST');
    return sendJson(res, 405, { error: 'GET 또는 POST만 지원합니다' });
  }
  sendJson(res, 200, { cookie: jar.getCookieString(target.href, { http: false }) });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (c) => {
      size += c.length;
      if (size > limit) {
        // 나머지는 읽어서 버린다 (소켓을 끊으면 413 응답도 못 보냄)
        req.off('data', onData);
        req.resume();
        reject(new Error(`바디가 너무 큽니다 (최대 ${limit}바이트)`));
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// 시작 페이지용 세션 API
//   GET  /__proxy/session        -> { active, id, cookies, sites: [{ domain, count, httpOnly }] }
//   POST /__proxy/session/reset  -> 현재 세션의 사이트 쿠키를 모두 삭제 -> { ok, cleared }
// 세션이 없는 브라우저에는 새 세션을 만들지 않는다.
// ---------------------------------------------------------------------------

export function handleSessionApi(req, res, store) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const session = store.existingSession(req);
  if (pathname === '/__proxy/session' && req.method === 'GET') {
    if (!session) return sendJson(res, 200, { active: false, id: null, cookies: 0, sites: [] });
    const sites = session.jar.summary();
    return sendJson(res, 200, {
      active: true,
      // 전체 ID는 HttpOnly 쿠키로만 다룬다. 화면에는 구분용 앞부분만
      id: `${session.sid.slice(0, 8)}…`,
      cookies: sites.reduce((n, s) => n + s.count, 0),
      sites,
    });
  }
  if (pathname === '/__proxy/session/reset' && req.method === 'POST') {
    const cleared = session ? session.jar.clear() : 0;
    debug('쿠키 초기화', cleared);
    return sendJson(res, 200, { ok: true, cleared });
  }
  res.setHeader('allow', pathname === '/__proxy/session' ? 'GET' : 'POST');
  return sendJson(res, 405, { error: '지원하지 않는 메서드입니다' });
}
