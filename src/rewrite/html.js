// HTML 안의 URL 속성들을 프록시 경로로 바꾼다. (parse5로 파싱 -> 트리 수정 -> 직렬화)
import { parse, serialize } from 'parse5';
import {
  proxify, proxifyRefresh, resolve, rewriteAttribute, rewriteSrcset, classifyScriptType, isEventHandlerAttribute,
} from '../shared/url.js';
import { rewriteCss, rewriteInlineStyle } from './css.js';
import { rewriteJs as defaultRewriteJs } from './js.js';

export const HOOK_SCRIPT_SRC = '/__proxy/hook.js';

// srcset 파서와 URL 속성 표는 브라우저(hook.js)와 공유하므로 shared/url.js 에 있다
export { rewriteSrcset };

/**
 * @param {string} html 디코딩된 HTML 문자열
 * @param {string} documentUrl 이 문서의 원본 URL
 * @param {{ charset?: string, cookie?: string, rewriteJs?: Function }} [options]
 *   charset: 원본 문서의 문자 인코딩 (예: 'euc-kr')
 *   cookie: 이 문서에서 document.cookie 로 보일 쿠키 문자열 (HttpOnly 제외). hook.js가 초기값으로 쓴다
 *   rewriteJs: (code, options) => code. 인라인 스크립트/이벤트 속성 변환기 (서버는 캐시를 붙여 넘김)
 * @returns {string}
 */
export function rewriteHtml(html, documentUrl, { charset = 'utf-8', cookie = '', rewriteJs = defaultRewriteJs } = {}) {
  const document = parse(html);
  const base = findBase(document, documentUrl);
  const ctx = { base, charset: charset.toLowerCase(), baseSeen: false, convert: (u) => proxify(u, base), rewriteJs };
  walk(document, (node) => rewriteNode(node, ctx));
  injectHook(document, cookie);
  return serialize(document);
}

// 문서에서 href가 있는 첫 번째 <base>가 기준 URL을 정한다 (base href 자체는 문서 URL 기준)
function findBase(document, documentUrl) {
  let base = documentUrl;
  walk(document, (node) => {
    if (node.tagName === 'base' && isHtml(node)) {
      const href = getAttr(node, 'href');
      if (href !== undefined) {
        base = resolve(href.trim(), documentUrl) ?? documentUrl;
        return false; // 탐색 중단
      }
    }
  });
  return base;
}

function rewriteNode(node, ctx) {
  if (node.nodeName === '#text' && node.parentNode?.tagName === 'style') {
    node.value = rewriteCss(node.value, ctx.base);
    return;
  }
  if (node.nodeName === '#text' && node.parentNode?.tagName === 'script') {
    // src가 있는 스크립트의 본문은 실행되지 않는다. JSON/JSON-LD/importmap/템플릿은 JS가 아님
    const script = node.parentNode;
    const kind = classifyScriptType(getAttr(script, 'type'));
    if (kind && getAttr(script, 'src') === undefined) {
      node.value = ctx.rewriteJs(node.value, { sourceType: kind === 'module' ? 'module' : 'script', base: ctx.base });
    }
    return;
  }
  if (!node.attrs) return;

  const tag = node.tagName;

  // <meta http-equiv=...>, <meta charset>
  if (tag === 'meta') {
    const equiv = getAttr(node, 'http-equiv')?.trim().toLowerCase();
    if (equiv === 'content-security-policy' || equiv === 'content-security-policy-report-only') {
      node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
      return 'removed';
    }
    if (equiv === 'refresh') setAttr(node, 'content', proxifyRefresh(getAttr(node, 'content') ?? '', ctx.base));
    // 응답은 UTF-8로 다시 인코딩해서 보내므로 문서 안의 선언도 맞춰 준다
    if (getAttr(node, 'charset') !== undefined) setAttr(node, 'charset', 'utf-8');
    if (equiv === 'content-type') setAttr(node, 'content', 'text/html; charset=utf-8');
  }

  for (let i = node.attrs.length - 1; i >= 0; i--) {
    const attr = node.attrs[i];
    const name = attr.name;
    if (name === 'integrity') {
      // 내용을 바꾸므로 SRI 검증이 실패한다
      node.attrs.splice(i, 1);
    } else if (tag === 'base' && name === 'href') {
      // 첫 base만 유효. 프록시 경로로 바꿔 두면 JS가 만드는 상대 URL도 프록시 안에서 해석된다
      if (!ctx.baseSeen) {
        ctx.baseSeen = true;
        attr.value = proxify(attr.value, ctx.base);
      }
    } else if (name === 'style') {
      attr.value = rewriteInlineStyle(attr.value, ctx.base);
    } else if (isEventHandlerAttribute(name)) {
      // onclick="location.href='/x'" 등: 함수 본문으로 파싱 (return 허용)
      attr.value = ctx.rewriteJs(attr.value, { sourceType: 'script', handler: true });
    } else {
      attr.value = rewriteAttribute(tag, name, attr.value, ctx.convert);
    }
  }

  // 원본이 UTF-8이 아니면 폼 전송 인코딩을 원본에 맞춘다 (서버가 EUC-KR 등을 기대)
  if (tag === 'form' && ctx.charset !== 'utf-8' && getAttr(node, 'accept-charset') === undefined) {
    node.attrs.push({ name: 'accept-charset', value: ctx.charset });
  }
}

// <head> 맨 앞에 클라이언트 훅 스크립트를 넣는다 (parse5는 head를 항상 만들어 준다).
// document.cookie 는 동기 API라서, 응답 시점의 쿠키를 속성으로 함께 내려 보내 첫 읽기부터 맞게 한다.
function injectHook(document, cookie) {
  let head;
  walk(document, (node) => {
    if (node.tagName === 'head' && isHtml(node)) {
      head = node;
      return false;
    }
  });
  if (!head) return;
  const script = {
    nodeName: 'script',
    tagName: 'script',
    attrs: [
      { name: 'src', value: HOOK_SCRIPT_SRC },
      { name: 'data-proxy-cookie', value: cookie },
    ],
    namespaceURI: head.namespaceURI,
    childNodes: [],
    parentNode: head,
  };
  head.childNodes.unshift(script);
}

// 깊이 우선 순회. visit가 false를 돌려주면 전체 중단. <template> 내용도 순회한다.
function walk(node, visit) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    const r = visit(n);
    if (r === false) return;
    if (r === 'removed') continue;
    const children = n.content ? n.content.childNodes : n.childNodes;
    if (children) for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

const isHtml = (node) => node.namespaceURI === 'http://www.w3.org/1999/xhtml';
const getAttr = (node, name) => node.attrs.find((a) => a.name === name && !a.prefix)?.value;
function setAttr(node, name, value) {
  const attr = node.attrs.find((a) => a.name === name && !a.prefix);
  if (attr) attr.value = value;
}
