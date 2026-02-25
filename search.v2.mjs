// search.v2.mjs (NEW) - scan 기능 건드리지 않는 "환자 검색" 전용 모듈

const searchBtn = document.getElementById("searchBtn");

let dlg = null;
let stream = null;
let rafId = null;
let html5 = null;

async function loadHtml5Qrcode(){
  if (window.Html5Qrcode) return window.Html5Qrcode;

  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  return window.Html5Qrcode;
}
function sanitize(t){
  return String(t || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

function tryJson(raw){
  const t = sanitize(raw);
  try { return JSON.parse(t); } catch { return null; }
}

function findPatientButton({ name, room, mrn }){
  const list = document.getElementById("patientList");
  if(!list) return null;

  const items = Array.from(list.querySelectorAll("button.item"));
  const n = (name || "").trim();
  const r = (room || "").trim();
  const m = (mrn  || "").trim();

  // 1) 이름 정확히 매칭 우선
  let hit = items.find(b => (b.textContent || "").trim().startsWith(n));
  if(!hit) hit = items.find(b => (b.textContent || "").includes(n));
  if(!hit) return null;

  // 2) room/mrn 있으면 추가로 맞는지 한번 더 필터(있을 때만)
  if(r || m){
    const txt = (hit.textContent || "");
    if(r && !txt.includes(r)) {
      // 같은 이름이 여러 명이면 room 기반으로 다시 찾기
      const hit2 = items.find(b => (b.textContent || "").includes(n) && (b.textContent || "").includes(r));
      if(hit2) hit = hit2;
    }
    if(m && !txt.includes(m)) {
      const hit3 = items.find(b => (b.textContent || "").includes(n) && (b.textContent || "").includes(m));
      if(hit3) hit = hit3;
    }
  }

  return hit;
}

function handlePatientQR(raw){
  const obj = tryJson(raw);
  if(!obj){
    alert("환자 QR 파싱 실패 (JSON 아님).");
    return;
  }

  const p = obj.patient || obj.p || null;
  const type = obj.type;

  if(type !== "patient" || !p || !p.name){
    alert("환자 QR이 아닙니다.");
    return;
  }

  const btn = findPatientButton({ name: p.name, room: p.room, mrn: p.mrn });
  if(!btn){
    alert(`환자 목록에서 찾지 못했습니다: ${p.name}`);
    return;
  }

  btn.click();
  closeSearch();
}

function ensureDialog(){
  if(dlg) return;

  dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <div class="dlg-head">🔍 환자 검색</div>
    <div class="dlg-body">
      <div class="hint" id="searchStatus">환자 QR을 스캔하세요 (스캐너/카메라)</div>

      <div style="display:flex; gap:10px; align-items:flex-start; flex-wrap:wrap;">
        <div style="flex:1; min-width:260px;">
          <div style="font-weight:700; margin-bottom:6px;">Camera (backup)</div>
          <div id="searchReader" style="width:320px; max-width:100%; background:#111; border-radius:12px; overflow:hidden;"></div>
          <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
            <button class="btn secondary" id="searchCamStart">Start camera</button>
            <button class="btn secondary" id="searchCamStop" disabled>Stop</button>
          </div>
        </div>

        <div style="flex:1; min-width:240px;">
          <div style="font-weight:700; margin-bottom:6px;">Scanner (Bluetooth/USB)</div>
          <div class="hint">아래 입력칸에 포커스 두고 스캐너로 찍은 뒤 Enter</div>
          <input id="searchInput" placeholder="Scan patient QR here…" autocomplete="off" autocapitalize="off" spellcheck="false" />
        </div>
      </div>
    </div>
    <div class="dlg-actions">
      <button class="btn secondary" id="searchClose">Close</button>
    </div>
  `;
  document.body.appendChild(dlg);

  dlg.querySelector("#searchClose").onclick = closeSearch;

  const input = dlg.querySelector("#searchInput");
  input.addEventListener("keydown", (e)=>{
    if(e.key === "Enter"){
      e.preventDefault();
      const v = input.value;
      input.value = "";
      handlePatientQR(v);
    }
  });

  dlg.querySelector("#searchCamStart").onclick = startCamera;
  dlg.querySelector("#searchCamStop").onclick = stopCamera;

  dlg.addEventListener("close", ()=>{
    stopCamera();
  });
}

function openSearch(){
  ensureDialog();
  dlg.showModal();
  const input = dlg.querySelector("#searchInput");
  setTimeout(()=> input && input.focus(), 50);
}

function closeSearch(){
  try{ dlg?.close(); }catch{}
  stopCamera();
}

// =======================
// Search Camera (html5-qrcode) - iPhone/Safari 지원
// =======================

let html5 = null;

async function loadHtml5Qrcode(){
  if (window.Html5Qrcode) return window.Html5Qrcode;

  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  return window.Html5Qrcode;
}

async function startCamera(){
  const statusEl = dlg.querySelector("#searchStatus");
  const startBtn = dlg.querySelector("#searchCamStart");
  const stopBtn  = dlg.querySelector("#searchCamStop");

  // 혹시 이전 실행 남아있으면 정리
  await stopCamera();

  statusEl.textContent = "카메라 시작 중…";

  try{
    const Html5Qrcode = await loadHtml5Qrcode();

    // ✅ ensureDialog()의 Camera 영역이 반드시 <div id="searchReader"></div> 여야 함
    const readerId = "searchReader";

    html5 = new Html5Qrcode(readerId);

    startBtn.disabled = true;
    stopBtn.disabled = false;

    const config = {
      fps: 10,
      qrbox: { width: 240, height: 240 }
    };

    await html5.start(
      { facingMode: "environment" },
      config,
      (decodedText) => {
        // 한 번 읽히면 바로 처리하고 종료
        handlePatientQR(decodedText);
      },
      (_err) => {}
    );

    statusEl.textContent = "카메라 켜짐. 환자 QR을 비추세요…";
  }catch(err){
    const msg = err?.message || String(err);
    statusEl.textContent = "카메라 실패: " + msg;

    startBtn.disabled = false;
    stopBtn.disabled = true;

    html5 = null;
  }
}

async function stopCamera(){
  const startBtn = dlg?.querySelector("#searchCamStart");
  const stopBtn  = dlg?.querySelector("#searchCamStop");

  try{
    if(html5){
      await html5.stop();
      await html5.clear();
    }
  }catch(_e){
    // ignore
  }finally{
    html5 = null;
    if(startBtn) startBtn.disabled = false;
    if(stopBtn)  stopBtn.disabled = true;
  }
}

// =======================
// Search Button wiring
// =======================
if(searchBtn){
  searchBtn.addEventListener("click", openSearch);
} else {
  console.warn("search.v2.mjs: #searchBtn not found");
}
