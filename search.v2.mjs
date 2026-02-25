/* search.v2.mjs (iPhone-safe)
   - No <dialog> (iOS Safari 이슈 회피)
   - Scanner default + Camera backup (html5-qrcode)
   - Patient QR -> auto navigate to patient MAR (click patient list item)
*/

const searchBtn = document.getElementById("searchBtn");

let overlayEl = null;
let html5 = null;

// ---------- helpers ----------
function sanitizeText(t){
  return String(t || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

function tryParsePatientQR(raw){
  const t = sanitizeText(raw);
  if(!t) return { ok:false, reason:"EMPTY" };

  let obj;
  try { obj = JSON.parse(t); } catch { return { ok:false, reason:"NOT_JSON" }; }

  if(!obj || obj.type !== "patient" || !obj.patient) return { ok:false, reason:"NOT_PATIENT" };

  const p = obj.patient || {};
  const name = sanitizeText(p.name);
  const room = sanitizeText(p.room);
  const mrn  = sanitizeText(p.mrn);

  if(!name && !mrn) return { ok:false, reason:"NO_KEY" };
  return { ok:true, name, room, mrn };
}

function findPatientButton({ name, room, mrn }){
  const list = document.getElementById("patientList");
  if(!list) return null;

  const items = Array.from(list.querySelectorAll("button.item"));
  if(!items.length) return null;

  const n = sanitizeText(name);
  const r = sanitizeText(room);
  const m = sanitizeText(mrn);

  // name 기반 우선
  if(n){
    let hit = items.find(b => sanitizeText(b.textContent).startsWith(n));
    if(!hit) hit = items.find(b => sanitizeText(b.textContent).includes(n));

    if(hit && (r || m)){
      const txt = sanitizeText(hit.textContent);
      if(r && !txt.includes(r)){
        const hit2 = items.find(b => sanitizeText(b.textContent).includes(n) && sanitizeText(b.textContent).includes(r));
        if(hit2) hit = hit2;
      }
      if(m && !txt.includes(m)){
        const hit3 = items.find(b => sanitizeText(b.textContent).includes(n) && sanitizeText(b.textContent).includes(m));
        if(hit3) hit = hit3;
      }
    }
    if(hit) return hit;
  }

  // mrn 기반 보조
  if(m){
    const hit = items.find(b => sanitizeText(b.textContent).includes(m));
    if(hit) return hit;
  }

  return null;
}

function navigateToPatientFromQR(raw){
  const parsed = tryParsePatientQR(raw);
  if(!parsed.ok){
    if(parsed.reason === "NOT_JSON") setStatus("환자 QR 파싱 실패 (JSON 아님).");
    else if(parsed.reason === "NOT_PATIENT") setStatus("환자 QR이 아닙니다.");
    else setStatus("환자 QR 인식 실패.");
    return false;
  }

  const btn = findPatientButton(parsed);
  if(!btn){
    setStatus(`환자 목록에서 찾지 못했습니다: ${parsed.name || parsed.mrn || "-"}`);
    return false;
  }

  btn.click();
  return true;
}

// ---------- html5-qrcode loader ----------
async function loadHtml5Qrcode(){
  if(window.Html5Qrcode) return window.Html5Qrcode;

  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  return window.Html5Qrcode;
}

// ---------- UI (overlay) ----------
function setStatus(msg){
  const el = overlayEl?.querySelector("#searchStatus");
  if(el) el.textContent = msg;
}

function openSearch(){
  if(overlayEl) return;

  overlayEl = document.createElement("div");
  overlayEl.className = "overlay";
  overlayEl.id = "searchOverlay";
  overlayEl.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div>🔍 환자 검색</div>
        <button class="btn secondary" id="searchCloseBtn">Close</button>
      </div>
      <div class="card-body">
        <div class="hint" id="searchStatus">스캐너로 환자 QR을 찍으세요. (기본) / 스캐너가 안되면 Camera 사용</div>

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
            <div class="hint">아래 입력칸에 포커스 → 스캐너로 찍고 Enter</div>
            <input id="searchInput" placeholder="Scan patient QR here…" autocomplete="off" autocapitalize="off" spellcheck="false" />
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlayEl);

  // close handlers
  overlayEl.querySelector("#searchCloseBtn").addEventListener("click", closeSearch);
  overlayEl.addEventListener("click", (e) => {
    // 바깥(overlay 배경) 클릭 시 닫기
    if(e.target === overlayEl) closeSearch();
  });

  // scanner default focus
  const input = overlayEl.querySelector("#searchInput");
  setTimeout(() => input?.focus(), 50);

  input.addEventListener("keydown", async (e) => {
    if(e.key !== "Enter") return;
    e.preventDefault();
    const v = input.value;
    input.value = "";

    if(navigateToPatientFromQR(v)){
      setStatus("환자 확인됨 → 이동 중…");
      await stopCamera();
      closeSearch();
    }
  });

  // camera buttons
  overlayEl.querySelector("#searchCamStart").addEventListener("click", startCamera);
  overlayEl.querySelector("#searchCamStop").addEventListener("click", stopCamera);
}

async function closeSearch(){
  await stopCamera();
  overlayEl?.remove();
  overlayEl = null;
}

async function startCamera(){
  if(!overlayEl) return;

  const startBtn = overlayEl.querySelector("#searchCamStart");
  const stopBtn  = overlayEl.querySelector("#searchCamStop");

  await stopCamera();

  setStatus("카메라 시작 중…");
  startBtn.disabled = true;
  stopBtn.disabled = false;

  try{
    const Html5Qrcode = await loadHtml5Qrcode();
    html5 = new Html5Qrcode("searchReader");

    const config = { fps: 10, qrbox: { width: 240, height: 240 } };

    await html5.start(
      { facingMode: "environment" },
      config,
      async (decodedText) => {
        if(navigateToPatientFromQR(decodedText)){
          setStatus("환자 확인됨 → 이동 중…");
          await closeSearch();
        }
      },
      (_err) => {}
    );

    setStatus("카메라 켜짐. 환자 QR을 비추세요…");
  }catch(err){
    setStatus("카메라 실패: " + (err?.message || String(err)));
    await stopCamera();
  }
}

async function stopCamera(){
  if(!overlayEl) {
    // overlay가 닫혔는데 html5만 남아있을 수 있어서 정리
    if(html5){
      try{ await html5.stop(); await html5.clear(); }catch{}
      html5 = null;
    }
    return;
  }

  const startBtn = overlayEl.querySelector("#searchCamStart");
  const stopBtn  = overlayEl.querySelector("#searchCamStop");

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

// ---------- Wire (iPhone: click + touchend) ----------
function wire(){
  const btn = document.getElementById("searchBtn");
  if(!btn){
    setTimeout(wire, 200);
    return;
  }

  // iOS에서 click이 씹히는 느낌 방지용
  btn.style.cursor = "pointer";
  btn.style.touchAction = "manipulation";

  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSearch();
  };

  btn.addEventListener("click", handler, { passive:false });
  btn.addEventListener("touchend", handler, { passive:false });
}

wire();
