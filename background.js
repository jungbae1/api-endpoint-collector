/*
 * background.js  —  서비스 워커 (Manifest V3)
 * -----------------------------------------------------------
 * 역할:
 *   1) chrome.webRequest 로 각 탭의 fetch/XHR 요청을 관찰(observe)만 함
 *      - 요청을 가로채거나 차단하지 않음 (webRequestBlocking 권한 사용 안 함)
 *      - URL, HTTP 메서드, 상태 코드를 수집
 *   2) content.js 가 보낸 "JS 정적 분석 결과(숨은 엔드포인트)"를 저장
 *   3) popup.js 의 요청에 대해 탭별 수집 결과를 돌려줌
 *
 * 저장 위치:
 *   - chrome.storage.session 에 탭ID별로 보관.
 *   - session 스토리지는 브라우저 세션 동안만 유지되고 디스크에 남지 않아
 *     진단 데이터가 불필요하게 영구 저장되는 것을 방지함.
 *
 * MV3 주의:
 *   - 서비스 워커는 유휴 시 종료될 수 있으므로, 메모리 캐시(tabData)에만
 *     의존하지 않고 storage.session 을 단일 진실 소스(source of truth)로 사용함.
 */

// requestId -> { url, method, type, tabId } 임시 매핑
// (onBeforeRequest 시점엔 상태코드를 모르므로 onCompleted 때 합치기 위함)
const pendingRequests = new Map();

// 요청/응답 타입 중 API 호출로 간주할 리소스 타입
// xmlhttprequest : fetch() 와 XMLHttpRequest 모두 이 타입으로 보고됨
const API_RESOURCE_TYPES = new Set(["xmlhttprequest"]);

/* ---------- storage.session 헬퍼 ---------- */

// 특정 탭의 저장된 데이터를 읽음. 없으면 기본 구조 반환.
async function getTabData(tabId) {
  const key = `tab_${tabId}`;
  const obj = await chrome.storage.session.get(key);
  return obj[key] || { network: {}, js: {} };
}

// 특정 탭의 데이터를 저장.
async function setTabData(tabId, data) {
  await chrome.storage.session.set({ [`tab_${tabId}`]: data });
}

// 네트워크 엔드포인트 하나를 탭 데이터에 병합(중복 제거).
// 키는 "메서드 + 공백 + URL" 로 만들어 같은 요청의 중복을 제거함.
async function upsertNetworkEntry(tabId, entry) {
  const data = await getTabData(tabId);
  const key = `${entry.method} ${entry.url}`;
  const prev = data.network[key] || {};
  data.network[key] = {
    url: entry.url,
    method: entry.method,
    // 상태 코드는 나중에(onCompleted) 채워지므로 기존 값을 보존하며 갱신
    status: entry.status != null ? entry.status : prev.status ?? null,
    source: "network",
    count: (prev.count || 0) + (entry.incrementCount ? 1 : 0),
  };
  await setTabData(tabId, data);
}

/* ---------- webRequest 리스너 ---------- */

// 1) 요청 시작: URL/메서드/타입을 임시 저장
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!API_RESOURCE_TYPES.has(details.type)) return;
    if (details.tabId < 0) return; // 탭에 속하지 않는 요청(확장/백그라운드)은 무시
    pendingRequests.set(details.requestId, {
      url: details.url,
      method: details.method,
      type: details.type,
      tabId: details.tabId,
    });
  },
  { urls: ["<all_urls>"] }
  // 참고: opt_extraInfoSpec 에 "blocking" 을 넣지 않음 → 관찰 전용
);

// 2) 응답 완료: 상태 코드를 합쳐서 저장
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const pending = pendingRequests.get(details.requestId);
    if (!pending) return;
    pendingRequests.delete(details.requestId);
    await upsertNetworkEntry(pending.tabId, {
      url: pending.url,
      method: pending.method,
      status: details.statusCode,
      incrementCount: true,
    });
  },
  { urls: ["<all_urls>"] }
);

// 3) 에러 발생: 상태 코드 없이라도 기록(차단/실패도 진단에 유용)
chrome.webRequest.onErrorOccurred.addListener(
  async (details) => {
    const pending = pendingRequests.get(details.requestId);
    if (!pending) return;
    pendingRequests.delete(details.requestId);
    await upsertNetworkEntry(pending.tabId, {
      url: pending.url,
      method: pending.method,
      status: 0, // 0 = 네트워크 에러/차단
      incrementCount: true,
    });
  },
  { urls: ["<all_urls>"] }
);

/* ---------- 탭 정리 ---------- */

// 탭이 닫히면 해당 데이터 삭제
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tab_${tabId}`);
});

// 탭이 새 URL로 이동(메인 프레임 네비게이션)하면 이전 수집 결과를 초기화
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // loading 시작 + url 변경 시 초기화
  if (changeInfo.status === "loading" && changeInfo.url) {
    chrome.storage.session.remove(`tab_${tabId}`);
  }
});

/* ---------- 메시지 핸들러 ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // content.js 가 보낸 JS 정적 분석 결과 저장
  if (msg?.type === "JS_ENDPOINTS" && Array.isArray(msg.endpoints)) {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false });
      return true;
    }
    (async () => {
      const data = await getTabData(tabId);
      for (const ep of msg.endpoints) {
        // JS에서 찾은 경로는 메서드를 알 수 없으므로 "-" 로 표기
        const key = `js ${ep}`;
        if (!data.js[key]) {
          data.js[key] = {
            url: ep,
            method: "-",
            status: null,
            source: "js",
          };
        }
      }
      await setTabData(tabId, data);
      sendResponse({ ok: true, saved: msg.endpoints.length });
    })();
    return true; // 비동기 응답
  }

  // popup.js 의 수집 결과 요청
  if (msg?.type === "GET_RESULTS" && msg.tabId != null) {
    (async () => {
      const data = await getTabData(msg.tabId);
      // network + js 를 하나의 배열로 합쳐 반환
      const rows = [
        ...Object.values(data.network),
        ...Object.values(data.js),
      ];
      sendResponse({ ok: true, rows });
    })();
    return true;
  }

  // 특정 탭 결과 초기화
  if (msg?.type === "CLEAR" && msg.tabId != null) {
    chrome.storage.session.remove(`tab_${msg.tabId}`, () =>
      sendResponse({ ok: true })
    );
    return true;
  }

  return false;
});
