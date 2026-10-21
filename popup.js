/*
 * popup.js  —  팝업 UI 로직
 * -----------------------------------------------------------
 * 역할:
 *   1) 현재 활성 탭에 content.js(정적 분석)를 주입해 실행
 *   2) background.js 에서 네트워크 + JS 수집 결과를 받아옴
 *   3) 테이블 렌더링, 검색/필터, 복사, JSON 내보내기, 초기화
 *
 * 외부 라이브러리 없이 순수 DOM API 로 구현.
 * (MV3 CSP 때문에 인라인 스크립트/핸들러 불가 → 모두 addEventListener 사용)
 */

let activeTabId = null;   // 현재 대상 탭 ID
let allRows = [];         // 서버(백그라운드)에서 받은 전체 행

const $ = (id) => document.getElementById(id);

// "API로 보이는" 경로인지 판별 → 하이라이트/필터에 사용
// 네트워크 요청은 모든 fetch/XHR를 수집하므로, 이 기준으로 API만 강조함.
const API_RE = /\/(?:api|v\d+|graphql)(?:\/|$|\?)/i;
function isApi(url) {
  return API_RE.test(url);
}

// HTTP 상태코드 → CSS 클래스 (색상 구분)
function statusClass(status) {
  if (status === 0) return "s-0";
  if (status == null) return "";
  if (status >= 200 && status < 300) return "s-2xx";
  if (status >= 300 && status < 400) return "s-3xx";
  if (status >= 400 && status < 500) return "s-4xx";
  if (status >= 500) return "s-5xx";
  return "";
}

/* ---------- 데이터 로드 ---------- */

// 활성 탭 조회
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// content.js 를 주입해 JS 정적 분석을 트리거
async function runStaticAnalysis(tabId, tabUrl) {
  // chrome:// 등 주입 불가능한 페이지는 건너뜀
  if (!tabUrl || /^(chrome|edge|about|chrome-extension|devtools):/i.test(tabUrl)) {
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (e) {
    // 권한 없는 페이지 등은 조용히 무시
    console.debug("executeScript 실패:", e.message);
  }
}

// 백그라운드에서 수집 결과 요청
async function fetchResults(tabId) {
  const resp = await chrome.runtime.sendMessage({ type: "GET_RESULTS", tabId });
  return resp?.rows || [];
}

// 전체 리로드: 정적 분석 실행 → 결과 수신 → 렌더
async function reload() {
  const tab = await getActiveTab();
  if (!tab) return;
  activeTabId = tab.id;

  await runStaticAnalysis(tab.id, tab.url);
  // 정적 분석 fetch 가 끝날 시간을 약간 준 뒤 결과 수신
  await new Promise((r) => setTimeout(r, 400));
  allRows = await fetchResults(tab.id);
  render();
}

/* ---------- 렌더링 & 필터 ---------- */

function getFiltered() {
  const q = $("search").value.trim().toLowerCase();
  const apiOnly = $("apiOnly").checked;
  return allRows.filter((row) => {
    if (apiOnly && !isApi(row.url)) return false;
    if (!q) return true;
    return (
      row.url.toLowerCase().includes(q) ||
      (row.method || "").toLowerCase().includes(q)
    );
  });
}

function render() {
  const rows = getFiltered();
  const tbody = $("rows");
  tbody.textContent = "";

  // 정렬: API 먼저, 그다음 메서드/경로 순
  rows.sort((a, b) => {
    const ai = isApi(a.url) ? 0 : 1;
    const bi = isApi(b.url) ? 0 : 1;
    if (ai !== bi) return ai - bi;
    return (a.url || "").localeCompare(b.url || "");
  });

  for (const row of rows) {
    const tr = document.createElement("tr");
    if (isApi(row.url)) tr.className = "api";

    const tdM = document.createElement("td");
    tdM.className = "method";
    tdM.textContent = row.method || "-";

    const tdP = document.createElement("td");
    tdP.className = "path";
    tdP.textContent = row.url;

    const tdS = document.createElement("td");
    tdS.className = row.source === "js" ? "src-js" : "";
    tdS.textContent = row.source;

    const tdSt = document.createElement("td");
    tdSt.className = "status " + statusClass(row.status);
    tdSt.textContent = row.status == null ? "-" : row.status === 0 ? "ERR" : row.status;

    tr.append(tdM, tdP, tdS, tdSt);
    tbody.appendChild(tr);
  }

  $("count").textContent = `${rows.length}개`;
  $("empty").style.display = rows.length ? "none" : "block";
}

/* ---------- 복사 / 내보내기 ---------- */

// 현재 필터된 결과를 JSON 문자열로 직렬화
function toJson() {
  const rows = getFiltered().map((r) => ({
    method: r.method,
    url: r.url,
    source: r.source,
    status: r.status,
  }));
  return JSON.stringify(rows, null, 2);
}

async function copyToClipboard() {
  try {
    await navigator.clipboard.writeText(toJson());
    flash($("copy"), "복사됨!");
  } catch (e) {
    flash($("copy"), "실패");
  }
}

// JSON 파일로 다운로드 (사용자 확장 로컬 동작 — 외부 전송 없음)
function exportJson() {
  const blob = new Blob([toJson()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `api-endpoints-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// 버튼에 잠깐 피드백 텍스트 표시
function flash(btn, text) {
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = orig), 1000);
}

/* ---------- 이벤트 바인딩 ---------- */

document.addEventListener("DOMContentLoaded", () => {
  $("search").addEventListener("input", render);
  $("apiOnly").addEventListener("change", render);
  $("refresh").addEventListener("click", reload);
  $("copy").addEventListener("click", copyToClipboard);
  $("export").addEventListener("click", exportJson);
  $("clear").addEventListener("click", async () => {
    if (activeTabId != null) {
      await chrome.runtime.sendMessage({ type: "CLEAR", tabId: activeTabId });
      allRows = [];
      render();
    }
  });

  // 팝업 열자마자 1회 로드
  reload();
});
