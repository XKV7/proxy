// 클라이언트 훅. 모든 프록시 HTML 문서의 <head> 맨 앞에서 (페이지 스크립트보다 먼저) 실행된다.
// 일반(classic) 스크립트이며 전역을 더럽히지 않도록 즉시 실행 함수로 감싼다.
(() => {
  // ---- 서비스 워커 등록 (4단계) ----
  // 이 페이지가 아직 서비스 워커의 제어를 받지 않으면 등록하고, 제어가 시작되면 한 번 새로고침한다.
  // (첫 로드에서 이미 실행된 페이지 스크립트의 요청은 워커를 거치지 않았기 때문)
  const sw = navigator.serviceWorker;
  if (sw && !sw.controller) {
    let reloading = false;
    sw.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
    sw.register('/__proxy/sw.js', { scope: '/', type: 'module', updateViaCache: 'none' })
      .then((reg) => {
        // 이미 활성화된 워커가 있는데 이 페이지를 제어하지 않는 경우(강력 새로고침 등)
        if (reg.active && !sw.controller) reg.active.postMessage('claim');
      })
      .catch((err) => console.warn('[proxy] 서비스 워커 등록 실패:', err));
  }
})();
