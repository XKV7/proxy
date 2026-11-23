// 응답 바디의 문자 인코딩을 알아내 문자열로 디코딩한다.
// 변환된 결과는 항상 UTF-8로 보내므로, EUC-KR 같은 레거시 인코딩도 여기서 한 번만 풀면 된다.
//
// 결정 순서 (WHATWG Encoding/HTML/CSS 명세의 우선순위를 단순화)
//   1. BOM
//   2. Content-Type 헤더의 charset
//   3. 문서 안의 선언: HTML은 앞 1024바이트의 <meta>, CSS는 맨 앞의 @charset
//   4. UTF-8로 엄격하게 디코딩해 보고 실패하면 windows-1252 (브라우저 기본값)

/**
 * @param {Buffer} buf
 * @param {string|null} contentType Content-Type 헤더 값
 * @param {'html'|'css'} kind
 * @returns {{ text: string, charset: string }} charset은 WHATWG 정규 이름 (예: 'euc-kr', 'utf-8')
 */
export function decodeBody(buf, contentType, kind) {
  const charset = detectCharset(buf, contentType, kind);
  // TextDecoder는 기본적으로 BOM을 제거해 준다
  return { text: new TextDecoder(charset).decode(buf), charset };
}

export function detectCharset(buf, contentType, kind) {
  const bom = sniffBom(buf);
  if (bom) return bom;

  const fromHeader = normalize(/;\s*charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType ?? '')?.[1]);
  if (fromHeader) return fromHeader;

  const head = buf.subarray(0, 1024).toString('latin1');
  let declared;
  if (kind === 'html') {
    // <meta charset="x"> 와 <meta http-equiv="Content-Type" content="text/html; charset=x"> 모두 처리
    declared = /<meta\b[^>]*?charset\s*=\s*["']?\s*([^"'\s/>;]+)/i.exec(head)?.[1];
    // 명세: meta로 선언된 UTF-16은 UTF-8로 취급 (바이트가 ASCII 호환이어야 meta를 읽을 수 있으므로)
    if (/^utf-16/i.test(declared ?? '')) declared = 'utf-8';
  } else if (kind === 'css') {
    declared = /^@charset "([^"]*)";/.exec(head)?.[1];
  }
  const fromDoc = normalize(declared);
  if (fromDoc) return fromDoc;

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

function sniffBom(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  return null;
}

// 레이블(ks_c_5601-1987, EUC-KR, cp949 ...)을 정규 이름으로. 모르는 레이블이면 null
function normalize(label) {
  if (!label) return null;
  try {
    return new TextDecoder(label.trim()).encoding;
  } catch {
    return null;
  }
}
