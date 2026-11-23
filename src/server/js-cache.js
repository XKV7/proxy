// JS 변환 결과 캐시: 원본 내용 해시 -> 변환 결과. 메모리 LRU + (선택) 디스크.
//
// 같은 라이브러리(jQuery, React 번들 등)는 여러 사이트/페이지에서 반복해 내려오므로
// 파싱/출력을 매번 하지 않도록 한다.
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { transformJs, REWRITER_VERSION } from '../rewrite/js.js';

const debug = process.env.DEBUG === '1' ? (...a) => console.log('[js-cache]', ...a) : () => {};

const LARGE_FILE = 1024 * 1024; // 이보다 큰 파일은 변환 시간을 로그로 남김
// 이보다 작은 코드(짧은 인라인 스크립트 등)는 디스크에 쓰지 않는다 (파일만 많아짐)
const DISK_MIN_SIZE = 4 * 1024;

export class JsCache {
  /** @param {{ dir?: string|null, maxBytes?: number }} [options] */
  constructor({ dir = null, maxBytes = 64 * 1024 * 1024 } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    /** @type {Map<string, string>} 삽입 순서 = 사용 순서 (오래된 것이 앞) */
    this.memory = new Map();
    this.bytes = 0;
    this.stats = { hits: 0, diskHits: 0, misses: 0 };
  }

  /**
   * 캐시 키. 변환 결과에 영향을 주는 옵션만 넣는다.
   * base(원본 URL)는 import 경로 변환에만 쓰이므로, import/export가 없는 코드는 URL과 무관하게 공유한다.
   */
  static key(code, { sourceType = 'auto', base, handler = false, prelude = false } = {}) {
    const usesBase = base && /\bimport\b|\bexport\b/.test(code);
    return createHash('sha256')
      .update(JSON.stringify([REWRITER_VERSION, sourceType, usesBase ? base : null, handler, prelude]))
      .update('\0')
      .update(code)
      .digest('hex');
  }

  getMemory(key) {
    const v = this.memory.get(key);
    if (v === undefined) return undefined;
    // 최근 사용으로 갱신
    this.memory.delete(key);
    this.memory.set(key, v);
    return v;
  }

  setMemory(key, value) {
    if (this.memory.has(key)) {
      this.bytes -= this.memory.get(key).length;
      this.memory.delete(key);
    }
    this.memory.set(key, value);
    this.bytes += value.length;
    for (const [k, v] of this.memory) {
      if (this.bytes <= this.maxBytes) break;
      this.memory.delete(k);
      this.bytes -= v.length;
    }
  }

  #path(key) {
    return join(this.dir, key.slice(0, 2), `${key}.js`);
  }

  async getDisk(key) {
    if (!this.dir) return undefined;
    try {
      return await readFile(this.#path(key), 'utf8');
    } catch {
      return undefined;
    }
  }

  async setDisk(key, value) {
    if (!this.dir) return;
    const file = this.#path(key);
    try {
      await mkdir(join(this.dir, key.slice(0, 2)), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, value);
      await rename(tmp, file);
    } catch (err) {
      debug('디스크 저장 실패:', err.message);
    }
  }

  /** 메모리 캐시만 쓰는 동기 변환 (HTML 안의 인라인 스크립트/이벤트 속성용) */
  rewriteSync(code, options = {}) {
    const key = JsCache.key(code, options);
    const cached = this.getMemory(key);
    if (cached !== undefined) {
      this.stats.hits++;
      return cached;
    }
    this.stats.misses++;
    const out = run(code, options);
    this.setMemory(key, out);
    return out;
  }

  /** 메모리 -> 디스크 -> 변환 (외부 JS 파일용) */
  async rewrite(code, options = {}) {
    const key = JsCache.key(code, options);
    const cached = this.getMemory(key);
    if (cached !== undefined) {
      this.stats.hits++;
      return cached;
    }
    const onDisk = await this.getDisk(key);
    if (onDisk !== undefined) {
      this.stats.diskHits++;
      this.setMemory(key, onDisk);
      return onDisk;
    }
    this.stats.misses++;
    const out = run(code, options);
    this.setMemory(key, out);
    if (code.length >= DISK_MIN_SIZE) await this.setDisk(key, out);
    return out;
  }
}

function run(code, options) {
  const started = performance.now();
  const result = transformJs(code, options);
  if (code.length > LARGE_FILE) {
    const ms = (performance.now() - started).toFixed(0);
    debug(`큰 파일 변환 ${(code.length / LARGE_FILE).toFixed(1)}MB ${ms}ms`, result.ok ? '' : '(파싱 실패, 원본 유지)', options.base ?? '');
  }
  return result.code;
}
