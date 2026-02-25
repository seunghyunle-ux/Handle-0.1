// search.v2.mjs (NEW) - scan 기능 건드리지 않는 "환자 검색" 전용 모듈

const searchBtn = document.getElementById("searchBtn");

let dlg = null;
let stream = null;
let rafId = null;

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
          <video id="searchVideo" style="width:320px; max-width:100%; background:#111; border-radius:12px;"></video>
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

async function startCamera(){
  const statusEl = dlg.querySelector("#searchStatus");
  const video = dlg.querySelector("#searchVideo");
  const startBtn = dlg.querySelector("#searchCamStart");
  const stopBtn  = dlg.querySelector("#searchCamStop");

  if(!("BarcodeDetector" in window)){
    statusEl.textContent = "이 브라우저는 카메라 QR(BarcodeDetector) 미지원. 스캐너 입력을 사용하세요.";
    return;
  }

  try{
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:"environment" } });
    video.srcObject = stream;
    await video.play();

    startBtn.disabled = true;
    stopBtn.disabled = false;

    const detector = new BarcodeDetector({ formats:["qr_code"] });

    const loop = async ()=>{
      if(!dlg?.open) return;
      try{
        const codes = await detector.detect(video);
        if(codes?.length){
          handlePatientQR(codes[0].rawValue);
          return;
        }
      }catch{}
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

  }catch{
    statusEl.textContent = "카메라 오류/권한 거부. 스캐너 입력을 사용하세요.";
    stopCamera();
  }
}

function stopCamera(){
  if(rafId){ cancelAnimationFrame(rafId); rafId = null; }
  if(stream){ stream.getTracks().forEach(t=>t.stop()); stream = null; }

  const startBtn = dlg?.querySelector("#searchCamStart");
  const stopBtn  = dlg?.querySelector("#searchCamStop");
  if(startBtn) startBtn.disabled = false;
  if(stopBtn)  stopBtn.disabled = true;

  const video = dlg?.querySelector("#searchVideo");
  if(video){ video.pause?.(); video.srcObject = null; }
}

if(searchBtn){
  searchBtn.addEventListener("click", openSearch);
} else {
  console.warn("search.v2.mjs: #searchBtn not found");
}
