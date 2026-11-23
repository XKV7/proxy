// 클라이언트 훅. 모든 프록시 HTML 문서의 <head> 맨 앞에서 (페이지 스크립트보다 먼저) 실행된다.
//
// 이 파일은 단독으로 로드되지 않는다. 서버(src/server/hook-bundle.js)가 src/shared/url.js 와
// 합쳐 하나의 즉시 실행 함수로 제공하므로, url.js 의 함수(proxify, decodeProxyUrl ...)를
// 같은 스코프에서 바로 쓴다.
//
// 목표: 페이지 JS가 "나는 원본 주소(https://site/...)에 있다"고 믿게 하면서,
//       JS가 만드는 모든 요청/URL은 프록시(/p/...)를 거치게 한다.

installHook(window);

function installHook(window) {
  if (window.__proxy) return; // 같은 창에 두 번 설치하지 않음

  const { document, navigator } = window;
  const realLocation = window.location;
  const proxyOrigin = realLocation.origin;

  // 현재 원본 URL (pushState, 해시 변경을 따라가도록 매번 계산)
  const currentHref = () => {
    const original = decodeProxyUrl(realLocation.pathname + realLocation.search);
    return original ? original.split('#')[0] + realLocation.hash : realLocation.href;
  };
  const originalOrigin = new URL(currentHref()).origin;
  // 상대 URL 해석 기준: <base href>가 있으면 그것(서버가 /p/... 로 바꿔 둠), 없으면 문서 URL
  const originalBase = () => {
    try {
      const b = new URL(document.baseURI);
      return decodeProxyUrl(b.pathname + b.search) ?? currentHref();
    } catch {
      return currentHref();
    }
  };
  const toProxy = (value) => proxifyClientUrl(value, originalBase(), proxyOrigin);
  const fromProxy = (value) => {
    try {
      const u = new URL(String(value), realLocation.href);
      return u.origin === proxyOrigin ? decodeProxyUrl(u.pathname + u.search) : null;
    } catch {
      return null;
    }
  };

  // ---------------------------------------------------------------------------
  // 덮어쓴 함수가 native 함수처럼 보이게 (fn.toString() 검사 대비)
  // ---------------------------------------------------------------------------
  const nativeToString = window.Function.prototype.toString;
  const nativeSource = new WeakMap(); // 대체 함수 -> 원래 함수의 toString 결과

  function disguise(fake, original) {
    nativeSource.set(fake, nativeToString.call(original));
    try {
      Object.defineProperty(fake, 'name', { value: original.name, configurable: true });
      Object.defineProperty(fake, 'length', { value: original.length, configurable: true });
    } catch { /* Proxy 등은 무시 */ }
    return fake;
  }
  // 메서드 축약 문법으로 만들면 native 메서드처럼 prototype 속성이 없고 new 로 호출할 수 없다
  const replaceToString = {
    toString() {
      return nativeSource.has(this) ? nativeSource.get(this) : nativeToString.call(this);
    },
  }.toString;
  disguise(replaceToString, nativeToString);
  window.Function.prototype.toString = replaceToString;

  /** obj[name] 메서드를 impl로 바꾼다. impl(original, ...args)는 this를 그대로 받는다 */
  function patchMethod(obj, name, impl) {
    const original = obj?.[name];
    if (typeof original !== 'function') return;
    const fake = {
      [name](...args) {
        return impl.call(this, original, ...args);
      },
    }[name];
    disguise(fake, original);
    obj[name] = fake;
  }

  /**
   * 접근자 속성의 setter/getter를 바꾼다. 원래 descriptor를 기반으로 일부만 교체.
   * defineIfMissing: 환경에 원래 속성이 없어도 새로 정의 (예: document.domain이 없는 환경)
   */
  function patchAccessor(obj, prop, { get, set, defineIfMissing = false }) {
    if (!obj) return;
    let desc = Object.getOwnPropertyDescriptor(obj, prop);
    if (!desc && defineIfMissing) {
      desc = { get() {}, set() {}, configurable: true, enumerable: true };
    }
    if (!desc || !desc.configurable) return;
    const next = { ...desc };
    if (get && desc.get) {
      next.get = { get [prop]() { return get.call(this, desc.get); } }.__lookupGetter__(prop);
      disguise(next.get, desc.get);
    }
    if (set && desc.set) {
      next.set = { set [prop](v) { set.call(this, desc.set, v); } }.__lookupSetter__(prop);
      disguise(next.set, desc.set);
    }
    Object.defineProperty(obj, prop, next);
  }

  /** 생성자를 Proxy로 감싸 첫 인자(URL)를 바꾼다. prototype, 정적 상수, instanceof, 상속이 그대로 유지된다 */
  function patchConstructor(name, mapArgs) {
    const Original = window[name];
    if (typeof Original !== 'function') return;
    const Wrapped = new Proxy(Original, {
      construct(target, args, newTarget) {
        return Reflect.construct(target, mapArgs(args), newTarget === Wrapped ? target : newTarget);
      },
    });
    nativeSource.set(Wrapped, nativeToString.call(Original));
    window[name] = Wrapped;
  }

  // ---------------------------------------------------------------------------
  // 네트워크 API
  // ---------------------------------------------------------------------------
  const nativeFetch = window.fetch?.bind(window);
  const nativeXhrOpen = window.XMLHttpRequest?.prototype.open;
  const nativeEval = window.eval;

  // ---------------------------------------------------------------------------
  // 런타임 코드 변환 (eval, new Function, setTimeout 문자열, on* 속성, 동적 <script> 텍스트)
  // 변환기(acorn + astring + js.js, 약 300KB)는 실제로 필요할 때 한 번만 동기로 받아 온다.
  // eval 은 동기 API라서 비동기로 기다릴 수 없기 때문이다.
  // ---------------------------------------------------------------------------
  const REWRITER_KEY = Symbol.for('proxy.rewriter');
  // 이 단어들이 없으면 변환할 것이 없으므로 변환기를 불러오지 않는다 (js.js의 QUICK_CHECK와 같은 기준)
  const CODE_HINT = /location|top|parent|eval|Function|\[|import|export/;
  let rewriterFailed = false;

  function loadRewriter() {
    if (window[REWRITER_KEY]) return window[REWRITER_KEY];
    if (rewriterFailed || !nativeXhrOpen) return null;
    try {
      const xhr = new window.XMLHttpRequest();
      nativeXhrOpen.call(xhr, 'GET', `${CLIENT_PREFIX}rewriter.js`, false);
      xhr.send();
      // 간접 eval: 전역 스코프에서 평가. 번들이 window[REWRITER_KEY] 에 자신을 등록한다
      if (xhr.status === 200) (0, nativeEval)(xhr.responseText);
    } catch (err) {
      console.warn('[proxy] 코드 변환기를 불러오지 못했습니다:', err);
    }
    if (!window[REWRITER_KEY]) rewriterFailed = true;
    return window[REWRITER_KEY] ?? null;
  }

  /** 문자열 코드를 변환. 변환기를 못 쓰면 원본 그대로 */
  function rewriteCode(code, options = {}) {
    if (typeof code !== 'string' || !CODE_HINT.test(code)) return code;
    const rewriter = loadRewriter();
    return rewriter ? rewriter.rewriteJs(code, { sourceType: 'script', base: originalBase(), ...options }) : code;
  }
  function rewriteFunctionArgs(args) {
    const body = args[args.length - 1];
    if (typeof body !== 'string' || !CODE_HINT.test(body)) return args;
    const rewriter = loadRewriter();
    return rewriter ? rewriter.rewriteFunctionArgs(args, { base: originalBase() }) : args;
  }
  /** <script> 요소의 본문으로 넣는 코드 */
  function rewriteScriptText(el, code) {
    const kind = classifyScriptType(el.getAttribute('type'));
    return kind ? rewriteCode(String(code), { sourceType: kind }) : code;
  }

  for (const name of ['setTimeout', 'setInterval']) {
    patchMethod(window, name, function (original, handler, ...rest) {
      return original.call(this ?? window, typeof handler === 'string' ? rewriteCode(handler) : handler, ...rest);
    });
  }

  patchMethod(window, 'fetch', function (fetch, input, init) {
    if (typeof window.Request === 'function' && input instanceof window.Request) {
      const target = toProxy(input.url);
      if (target !== input.url) input = new window.Request(target, input);
    } else if (input !== undefined) {
      input = toProxy(input);
    }
    const startedAt = cookieJar.version();
    const result = fetch.call(this, input, init);
    // 원본 응답에 Set-Cookie가 있었으면 서버가 갱신된 document.cookie 값을 헤더로 알려 준다
    result.then((res) => cookieJar.fromHeader(res.headers.get(DOCUMENT_COOKIE_HEADER), startedAt), () => {});
    return result;
  });

  patchMethod(window.XMLHttpRequest?.prototype, 'open', function (open, method, url, ...rest) {
    const startedAt = cookieJar.version();
    this.addEventListener('loadend', () => {
      cookieJar.fromHeader(this.getResponseHeader(DOCUMENT_COOKIE_HEADER), startedAt);
    });
    return open.call(this, method, toProxy(url), ...rest);
  });

  patchMethod(window.Navigator?.prototype, 'sendBeacon', function (sendBeacon, url, data) {
    return sendBeacon.call(this, toProxy(url), data);
  });

  patchConstructor('EventSource', ([url, ...rest]) => [toProxy(url), ...rest]);

  patchConstructor('WebSocket', ([url, ...rest]) => [
    encodeWsProxyUrl(url, originalBase(), proxyOrigin, originalOrigin) ?? url,
    ...rest,
  ]);

  // ---------------------------------------------------------------------------
  // 창/히스토리
  // ---------------------------------------------------------------------------
  patchMethod(window, 'open', function (open, url, ...rest) {
    return open.call(this, url === undefined || url === null ? url : toProxy(url), ...rest);
  });

  for (const name of ['pushState', 'replaceState']) {
    patchMethod(window.History?.prototype, name, function (original, state, title, url) {
      return url === undefined || url === null
        ? original.call(this, state, title)
        : original.call(this, state, title, toProxy(url));
    });
  }

  // ---------------------------------------------------------------------------
  // DOM: 동적으로 만든 요소의 URL 속성
  // ---------------------------------------------------------------------------
  const tagOf = (el) => String(el.localName || '').toLowerCase();
  const convertAttr = (el, attr, value) => rewriteAttribute(tagOf(el), attr, String(value), toProxy);

  // img.src = '...', a.href = '...' 같은 속성 대입
  const URL_PROPERTIES = {
    HTMLImageElement: ['src', 'srcset'],
    HTMLSourceElement: ['src', 'srcset'],
    HTMLScriptElement: ['src'],
    HTMLIFrameElement: ['src'],
    HTMLFrameElement: ['src'],
    HTMLEmbedElement: ['src'],
    HTMLMediaElement: ['src'],
    HTMLTrackElement: ['src'],
    HTMLInputElement: ['src', 'formAction'],
    HTMLButtonElement: ['formAction'],
    HTMLVideoElement: ['poster'],
    HTMLAnchorElement: ['href'],
    HTMLAreaElement: ['href'],
    HTMLLinkElement: ['href', 'imageSrcset'],
    HTMLBaseElement: ['href'],
    HTMLFormElement: ['action'],
    HTMLObjectElement: ['data'],
  };
  for (const [iface, props] of Object.entries(URL_PROPERTIES)) {
    for (const prop of props) {
      const attr = prop.toLowerCase();
      patchAccessor(window[iface]?.prototype, prop, {
        set(setter, value) {
          setter.call(this, convertAttr(this, attr, value));
        },
      });
    }
  }
  // 내용을 바꿔 보내므로 SRI(integrity) 검증은 항상 실패한다 -> 설정을 무시
  for (const iface of ['HTMLScriptElement', 'HTMLLinkElement']) {
    patchAccessor(window[iface]?.prototype, 'integrity', { set() {} });
  }

  const nativeSetAttribute = window.Element.prototype.setAttribute;
  patchMethod(window.Element.prototype, 'setAttribute', function (setAttribute, name, value) {
    const attr = String(name).toLowerCase();
    if (attr === 'integrity') return undefined;
    if (isEventHandlerAttribute(attr)) return setAttribute.call(this, name, rewriteCode(String(value), { handler: true }));
    return setAttribute.call(this, name, convertAttr(this, attr, value));
  });
  patchMethod(window.Element.prototype, 'setAttributeNS', function (setAttributeNS, ns, name, value) {
    const local = String(name).split(':').pop().toLowerCase();
    return setAttributeNS.call(this, ns, name, convertAttr(this, local, value));
  });

  // innerHTML/outerHTML 대입, insertAdjacentHTML: 브라우저 파서로 <template>에 파싱(스크립트 실행/로딩 없음)
  // -> URL 속성 변환 -> 다시 직렬화해서 원래 setter에 넘긴다
  const innerHTMLDesc = Object.getOwnPropertyDescriptor(window.Element.prototype, 'innerHTML');
  const URL_ATTR_HINT = /\b(?:src|href|action|formaction|poster|data|srcset|imagesrcset|integrity|on\w+)\s*=/i;
  const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'iframe', 'noembed', 'noframes', 'plaintext']);

  function rewriteHtmlString(html) {
    const s = String(html);
    if (!URL_ATTR_HINT.test(s) || !innerHTMLDesc) return s;
    const template = document.createElement('template');
    innerHTMLDesc.set.call(template, s);
    rewriteTree(template.content);
    return innerHTMLDesc.get.call(template);
  }
  function rewriteTree(root) {
    for (const el of root.querySelectorAll('*')) {
      for (const { name, localName } of [...el.attributes]) {
        const attr = (localName || name).toLowerCase();
        if (attr === 'integrity') el.removeAttribute(name);
        else if (isEventHandlerAttribute(attr)) {
          nativeSetAttribute.call(el, name, rewriteCode(el.getAttribute(name), { handler: true }));
        } else if (isUrlAttribute(tagOf(el), attr)) {
          nativeSetAttribute.call(el, name, convertAttr(el, attr, el.getAttribute(name)));
        }
      }
      if (el.content && tagOf(el) === 'template') rewriteTree(el.content);
    }
  }

  patchAccessor(window.Element.prototype, 'innerHTML', {
    set(setter, value) {
      const tag = tagOf(this);
      if (tag === 'script') setter.call(this, rewriteScriptText(this, value));
      else setter.call(this, RAW_TEXT.has(tag) ? value : rewriteHtmlString(value));
    },
  });
  // 동적으로 만든 <script>의 본문: script.text = ..., script.textContent = ..., script.innerText = ...
  patchAccessor(window.HTMLScriptElement?.prototype, 'text', {
    set(setter, value) {
      setter.call(this, rewriteScriptText(this, value));
    },
  });
  patchAccessor(window.Node.prototype, 'textContent', {
    set(setter, value) {
      setter.call(this, tagOf(this) === 'script' && value != null ? rewriteScriptText(this, value) : value);
    },
  });
  patchAccessor(window.HTMLElement.prototype, 'innerText', {
    set(setter, value) {
      setter.call(this, tagOf(this) === 'script' && value != null ? rewriteScriptText(this, value) : value);
    },
  });
  patchAccessor(window.Element.prototype, 'outerHTML', {
    set(setter, value) {
      setter.call(this, rewriteHtmlString(value));
    },
  });
  patchMethod(window.Element.prototype, 'insertAdjacentHTML', function (insert, position, html) {
    return insert.call(this, position, rewriteHtmlString(html));
  });

  // ---------------------------------------------------------------------------
  // document.cookie: 서버 저장소(/__proxy/cookies)와 동기화되는 캐시
  // ---------------------------------------------------------------------------
  // 서버(proxy.js)가 원본 응답에 Set-Cookie가 있을 때 붙이는 헤더 (값은 encodeURIComponent)
  const DOCUMENT_COOKIE_HEADER = 'x-proxy-document-cookie';
  const cookieJar = createCookieCache();

  function createCookieCache() {
    const apiUrl = () => `${CLIENT_PREFIX}cookies?url=${encodeURIComponent(currentHref())}`;
    const hookScript = document.currentScript ?? document.querySelector('script[data-proxy-cookie]');
    let cache = parseCookieString(hookScript?.getAttribute('data-proxy-cookie') ?? '');
    hookScript?.removeAttribute('data-proxy-cookie');
    let version = 0; // 쓰기마다 증가. 오래된 서버 응답이 최신 쓰기를 덮지 않게 한다
    let refreshing = false;

    function apply(response, startedAt) {
      if (startedAt === version && typeof response?.cookie === 'string') cache = parseCookieString(response.cookie);
    }
    const refresh = () => {
      if (refreshing || !nativeFetch) return;
      refreshing = true;
      const startedAt = version;
      nativeFetch(apiUrl(), { credentials: 'same-origin', cache: 'no-store' })
        .then((r) => r.json())
        .then((data) => apply(data, startedAt))
        .catch(() => {})
        .finally(() => { refreshing = false; });
    };
    return {
      get: () => [...cache].map(([k, v]) => (k === '' ? v : `${k}=${v}`)).join('; '),
      set(value) {
        const str = String(value);
        // 서버 응답을 기다리지 않고 캐시에 먼저 반영 (document.cookie 는 바로 읽힐 수 있어야 함)
        const parsed = parseSetCookieLite(str);
        if (!parsed) return;
        if (parsed.delete) cache.delete(parsed.name);
        else cache.set(parsed.name, parsed.value);
        const startedAt = ++version;
        nativeFetch?.(apiUrl(), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'text/plain;charset=UTF-8' },
          body: str,
          keepalive: true, // 쓰고 바로 페이지를 떠나도 전송되도록
        })
          .then((r) => r.json())
          .then((data) => apply(data, startedAt))
          .catch(() => {});
      },
      refresh,
      version: () => version,
      /** 응답 헤더 값으로 캐시 갱신. 요청 시작 이후 document.cookie 쓰기가 있었으면 무시 */
      fromHeader(value, startedAt) {
        if (value === null || value === undefined) return;
        try {
          apply({ cookie: decodeURIComponent(value) }, startedAt);
        } catch { /* 잘못된 인코딩 무시 */ }
      },
    };
  }

  function parseCookieString(str) {
    const map = new Map();
    for (const part of str.split(';')) {
      const s = part.trim();
      if (!s) continue;
      const i = s.indexOf('=');
      map.set(i === -1 ? '' : s.slice(0, i), i === -1 ? s : s.slice(i + 1));
    }
    return map;
  }
  // 캐시 즉시 반영용 간이 파서. 최종 판단(Domain/Path/Secure 등)은 서버(cookies.js)가 한다
  function parseSetCookieLite(str) {
    const [pair, ...attrs] = str.split(';');
    const i = pair.indexOf('=');
    if (i === -1 || !pair.slice(0, i).trim()) return null;
    const name = pair.slice(0, i).trim();
    let del = false;
    for (const a of attrs) {
      const [k, v = ''] = a.split('=').map((x) => x.trim());
      const key = k.toLowerCase();
      if (key === 'httponly') return null; // JS로는 HttpOnly 쿠키를 만들 수 없다
      if (key === 'max-age' && /^-?\d+$/.test(v) && Number(v) <= 0) del = true;
      if (key === 'expires') {
        const t = Date.parse(v);
        if (!Number.isNaN(t) && t <= Date.now()) del = true;
      }
    }
    return { name, value: pair.slice(i + 1).trim(), delete: del };
  }

  patchAccessor(window.Document.prototype, 'cookie', {
    get() {
      return cookieJar.get();
    },
    set(_setter, value) {
      cookieJar.set(value);
    },
  });
  // HTTP 캐시에서 온 HTML이면 속성 값이 오래됐을 수 있으므로 한 번 확인
  cookieJar.refresh();

  // ---------------------------------------------------------------------------
  // document.domain / referrer / URL
  // ---------------------------------------------------------------------------
  patchAccessor(window.Document.prototype, 'domain', {
    get: () => new URL(currentHref()).hostname,
    set() {}, // 원본 도메인 기준 동작을 흉내낼 수 없으므로 무시 (최신 브라우저에서도 사실상 폐기됨)
    defineIfMissing: true,
  });
  patchAccessor(window.Document.prototype, 'referrer', {
    get(getter) {
      const real = getter.call(this);
      // 프록시 페이지에서 왔으면 원본 URL, 시작 페이지 등 프록시 밖이면 없음
      return real ? fromProxy(real) ?? '' : '';
    },
  });
  for (const prop of ['URL', 'documentURI']) {
    patchAccessor(window.Document.prototype, prop, { get: () => currentHref() });
  }

  // ---------------------------------------------------------------------------
  // localStorage / sessionStorage: 키 앞에 원본 origin을 붙여 사이트별로 분리
  // ---------------------------------------------------------------------------
  for (const name of ['localStorage', 'sessionStorage']) {
    let real;
    try {
      real = window[name];
    } catch {
      continue; // 저장소 사용이 막힌 환경
    }
    if (!real) continue;
    const wrapped = wrapStorage(real, `${originalOrigin}::`);
    const desc = Object.getOwnPropertyDescriptor(window, name) ?? Object.getOwnPropertyDescriptor(window.Window.prototype, name);
    const getter = { get [name]() { return wrapped; } }.__lookupGetter__(name);
    if (desc?.get) disguise(getter, desc.get);
    Object.defineProperty(window, name, { get: getter, configurable: true, enumerable: desc?.enumerable ?? true });
  }

  function wrapStorage(storage, prefix) {
    const S = window.Storage.prototype;
    const raw = {
      key: (i) => S.key.call(storage, i),
      get: (k) => S.getItem.call(storage, k),
      set: (k, v) => S.setItem.call(storage, k, v),
      remove: (k) => S.removeItem.call(storage, k),
    };
    const ownKeys = () => {
      const keys = [];
      const n = storage.length;
      for (let i = 0; i < n; i++) {
        const k = raw.key(i);
        if (k !== null && k.startsWith(prefix)) keys.push(k.slice(prefix.length));
      }
      return keys;
    };
    const api = {
      getItem(key) { return raw.get(prefix + key); },
      setItem(key, value) { raw.set(prefix + key, value); },
      removeItem(key) { raw.remove(prefix + key); },
      clear() { for (const k of ownKeys()) raw.remove(prefix + k); },
      key(index) { return ownKeys()[index] ?? null; },
    };
    for (const [name, fn] of Object.entries(api)) disguise(fn, S[name]);

    // storage.foo, storage.foo = 'x', delete storage.foo, Object.keys(storage), 'foo' in storage 까지 지원
    return new Proxy(storage, {
      get(_t, prop) {
        if (prop === 'length') return ownKeys().length;
        if (typeof prop === 'string' && Object.hasOwn(api, prop)) return api[prop];
        if (typeof prop === 'symbol' || prop in S) return Reflect.get(storage, prop);
        return raw.get(prefix + prop) ?? undefined;
      },
      set(_t, prop, value) {
        if (typeof prop === 'symbol') return false;
        raw.set(prefix + prop, String(value));
        return true;
      },
      has(_t, prop) {
        return typeof prop === 'string' && (raw.get(prefix + prop) !== null || prop in S);
      },
      deleteProperty(_t, prop) {
        if (typeof prop === 'string') raw.remove(prefix + prop);
        return true;
      },
      ownKeys: () => ownKeys(),
      getOwnPropertyDescriptor(_t, prop) {
        const v = typeof prop === 'string' ? raw.get(prefix + prop) : null;
        return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
      },
      defineProperty(_t, prop, desc) {
        if (typeof prop !== 'string' || !('value' in desc)) return false;
        raw.set(prefix + prop, String(desc.value));
        return true;
      },
      getPrototypeOf: () => S,
    });
  }

  // ---------------------------------------------------------------------------
  // __proxy.location: 원본 기준 값을 보여 주는 가짜 Location (6단계 AST 변환이 location 대신 사용)
  // ---------------------------------------------------------------------------
  const COMPONENTS = ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];
  const fakeLocation = {};
  for (const prop of [...COMPONENTS, 'origin']) {
    const desc = {
      get: () => new URL(currentHref())[prop],
      enumerable: true,
    };
    if (prop === 'href') {
      desc.set = (value) => { realLocation.href = toProxy(value); };
    } else if (prop === 'hash') {
      desc.set = (value) => { realLocation.hash = value; }; // 해시는 프록시 URL에서도 그대로
    } else if (prop !== 'origin') {
      desc.set = (value) => {
        const u = new URL(currentHref());
        u[prop] = value;
        realLocation.href = toProxy(u.href);
      };
    }
    Object.defineProperty(fakeLocation, prop, desc);
  }
  Object.assign(fakeLocation, {
    assign(url) { realLocation.assign(toProxy(url)); },
    replace(url) { realLocation.replace(toProxy(url)); },
    reload() { realLocation.reload(); },
    toString() { return currentHref(); },
  });
  Object.defineProperty(fakeLocation, Symbol.toStringTag, { value: 'Location' });

  // ---------------------------------------------------------------------------
  // window.__proxy
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // js.js(AST 변환)가 만든 코드가 부르는 함수들
  // ---------------------------------------------------------------------------
  const SPECIAL_KEYS = new Set(['location', 'top', 'parent']);
  const isWindowLike = (o) => {
    try {
      return o !== null && typeof o === 'object' && o.window === o;
    } catch {
      return false;
    }
  };
  const apiOf = (win) => {
    try {
      return win?.__proxy;
    } catch {
      return undefined;
    }
  };
  // obj가 창/문서면 그 창의 __proxy (다른 프록시 iframe/팝업이면 그쪽 것)
  const apiForTarget = (obj, key) => {
    if (isWindowLike(obj)) return apiOf(obj);
    if (key === 'location' && obj !== null && typeof obj === 'object' && obj.nodeType === 9) return apiOf(obj.defaultView);
    return undefined;
  };

  /** obj[key] 읽기. key가 location/top/parent이고 obj가 창/문서면 가짜 객체 */
  function proxyGet(obj, key) {
    if (typeof key !== 'string') {
      // 숫자/심볼 등은 바로 (배열 인덱스 같은 흔한 경우를 빠르게)
      if (key === null || (typeof key !== 'object' && typeof key !== 'function')) return obj[key];
      key = String(key);
    }
    if (!SPECIAL_KEYS.has(key)) return obj[key];
    const target = apiForTarget(obj, key);
    return target ? target[key] : obj[key];
  }

  /** obj[key] = value. location 대입은 가짜 location으로 (프록시 안에서 이동) */
  function proxySet(obj, key, value) {
    if (key !== null && typeof key === 'object') key = String(key);
    if (key === 'location') {
      const target = apiForTarget(obj, key);
      if (target) {
        target.location = value;
        return value;
      }
    }
    if (obj === null || obj === undefined) obj[key] = value; // 원래와 같은 TypeError
    // 원본 코드가 비엄격 모드일 수 있으므로 읽기 전용 속성 대입은 예외 없이 무시 (Reflect.set)
    if (typeof obj === 'object' || typeof obj === 'function') Reflect.set(obj, key, value);
    return value;
  }

  // top/parent: 위쪽 창도 프록시 페이지일 때만 그 창을 보여 준다 (프록시 밖의 틀은 숨긴다)
  function proxyTop() {
    let w = window;
    for (;;) {
      let p;
      try {
        p = w.parent;
      } catch {
        break;
      }
      if (!p || p === w || !apiOf(p)) break;
      w = p;
    }
    return w;
  }
  function proxyParent() {
    const p = window.parent;
    // parent = x 처럼 전역 변수로 쓰는 옛 코드는 진짜 window.parent를 바꿔 두므로 그 값을 그대로
    if (!isWindowLike(p)) return p;
    return p !== window && apiOf(p) ? p : window;
  }

  const api = Object.freeze({
    get url() { return currentHref(); },
    get origin() { return originalOrigin; },
    proxyOrigin,
    get location() { return fakeLocation; },
    set location(value) { fakeLocation.href = value; },
    get top() { return proxyTop(); },
    get parent() { return proxyParent(); },
    get: proxyGet,
    set: proxySet,
    /** eval 코드 변환 (js.js가 eval(x) -> eval(__proxy.rewrite(x)) 로 바꿈) */
    rewrite: (code) => rewriteCode(code),
    /** new Function 인자 변환 */
    rewriteFunctionArgs,
    /** 원본 URL(상대/절대) -> 프록시 경로 */
    toProxy,
    /** 프록시 URL -> 원본 URL (프록시 URL이 아니면 null) */
    fromProxy,
    toWebSocket: (url) => encodeWsProxyUrl(url, originalBase(), proxyOrigin, originalOrigin),
  });
  Object.defineProperty(window, '__proxy', { value: api, enumerable: false, configurable: false, writable: false });

  // ---------------------------------------------------------------------------
  // 서비스 워커 등록 (4단계)
  // 이 페이지가 아직 서비스 워커의 제어를 받지 않으면 등록하고, 제어가 시작되면 한 번 새로고침한다.
  // ---------------------------------------------------------------------------
  const sw = navigator.serviceWorker;
  if (sw && !sw.controller) {
    let reloading = false;
    sw.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      realLocation.reload();
    });
    sw.register('/__proxy/sw.js', { scope: '/', type: 'module', updateViaCache: 'none' })
      .then((reg) => {
        // 이미 활성화된 워커가 있는데 이 페이지를 제어하지 않는 경우(강력 새로고침 등)
        if (reg.active && !sw.controller) reg.active.postMessage('claim');
      })
      .catch((err) => console.warn('[proxy] 서비스 워커 등록 실패:', err));
  }
}
