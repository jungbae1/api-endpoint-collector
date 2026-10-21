/*
 * content.js  —  JS 번들 정적 분석 (콘텐츠 스크립트)
 * -----------------------------------------------------------
 * 역할:
 *   1) 현재 페이지에 로드된 모든 <script src="..."> 파일 URL을 수집
 *   2) 각 JS 파일을 fetch 로 받아 텍스트로 읽음
 *      - 확장에 <all_urls> host_permission 이 있어 교차 출처 스크립트도
 *        CORS 제약 없이 받을 수 있음
 *   3) 정규식으로 API 경로 패턴을 추출
 *   4) 중복 제거 후 background.js 로 전송
 *
 * 이 스크립트는 "읽기 전용"이며 페이지를 수정하지 않음.
 */

(() => {
  // 이미 한 번 분석했다면 재실행 방지 (여러 번 주입될 경우 대비)
  if (window.__apiEndpointCollectorRan) return;
  window.__apiEndpointCollectorRan = true;

  /* ----------------------------------------------------------
   * 정규식 패턴 & 오탐(false positive) 저감 설명
   * ----------------------------------------------------------
   *
   * [패턴 A] 절대 URL 형태의 API
   *   https?:\/\/[^\s"'`<>]+?\/(?:api|v\d+|graphql)\/[A-Za-z0-9_\-./:{}]*
   *   - https? : http/https 모두 허용
   *   - [^\s"'`<>]+? : 호스트+경로 앞부분. 공백/따옴표/백틱/꺾쇠는 제외하여
   *       문자열 경계를 넘어 과하게 매칭되는 것을 방지(게으른 +?)
   *   - \/(?:api|v\d+|graphql)\/ : /api/, /v1/, /v2/, /graphql/ 같은
   *       "API로 보이는 세그먼트"를 반드시 포함하도록 강제 → 오탐 핵심 억제
   *
   * [패턴 B] 상대 경로 형태의 API
   *   (?<![A-Za-z0-9_])\/(?:api|v\d+|graphql)(?:\/[A-Za-z0-9_\-.:{}]+)*
   *   - (?<![A-Za-z0-9_]) : 앞에 영숫자/언더스코어가 오면 제외.
   *       예) "/scapi/" 의 "api" 처럼 다른 단어의 일부를 잡지 않도록 함
   *   - 세그먼트 문자셋을 제한해 자바스크립트 코드 조각을 통째로 삼키지 않게 함
   *
   * 공통 오탐 저감 전략:
   *   - 결과를 후처리에서 한 번 더 필터:
   *       · 최소 길이, 확장자(.js/.css/.png 등) 끝나는 정적 리소스 제외
   *       · 정규식 특성상 끝에 붙는 구두점(," ) 등) 제거
   *   - 그래도 정적 분석은 "후보"이므로, 실제 호출 여부는
   *     네트워크 탭(source=network) 결과와 교차 확인하는 것을 권장.
   */
  const PATTERNS = [
    /https?:\/\/[^\s"'`<>]+?\/(?:api|v\d+|graphql)\/[A-Za-z0-9_\-./:{}]*/g,
    /(?<![A-Za-z0-9_])\/(?:api|v\d+|graphql)(?:\/[A-Za-z0-9_\-.:{}]+)*/g,
  ];

  // 정적 리소스로 끝나는 경로는 API 후보에서 제외
  const STATIC_EXT = /\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)$/i;

  // 매칭 결과 끝에 붙는 불필요한 구두점 정리
  function cleanup(raw) {
    return raw.replace(/["'`),;]+$/, "").trim();
  }

  function extractFromText(text, found) {
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const ep = cleanup(m[0]);
        if (ep.length < 4) continue;          // 너무 짧은 건 제외
        if (STATIC_EXT.test(ep)) continue;     // 정적 리소스 제외
        found.add(ep);
        // 폭주 방지: 파일당 과도한 매칭 시 중단
        if (found.size > 2000) return;
      }
    }
  }

  async function run() {
    const found = new Set();

    // 1) 인라인 스크립트 내용도 분석 (document에 직접 들어있는 코드)
    for (const s of document.scripts) {
      if (!s.src && s.textContent) {
        extractFromText(s.textContent, found);
      }
    }

    // 2) 외부 .js 파일 수집
    const srcs = Array.from(document.scripts)
      .map((s) => s.src)
      .filter((src) => src && /^https?:/i.test(src));
    const uniqueSrcs = Array.from(new Set(srcs));

    // 3) 각 파일을 받아 분석 (병렬, 실패는 조용히 무시)
    await Promise.all(
      uniqueSrcs.map(async (url) => {
        try {
          const res = await fetch(url, { credentials: "omit" });
          if (!res.ok) return;
          const text = await res.text();
          extractFromText(text, found);
        } catch (_) {
          /* CORS/네트워크 실패 등은 무시 */
        }
      })
    );

    // 4) 배경 서비스 워커로 전송
    const endpoints = Array.from(found);
    if (endpoints.length) {
      try {
        await chrome.runtime.sendMessage({ type: "JS_ENDPOINTS", endpoints });
      } catch (_) {
        /* 워커 비활성 등 — 무시 */
      }
    }
    return endpoints.length;
  }

  // 팝업이 scripting.executeScript 로 주입할 때 즉시 실행되며,
  // Promise 결과(발견 개수)를 executeScript 결과로도 돌려줌.
  return run();
})();
