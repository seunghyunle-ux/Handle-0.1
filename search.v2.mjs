/* search.v2.mjs
   - SAFE additive module (does NOT touch scan.v2.mjs)
   - Search popup: scanner default + camera backup (html5-qrcode)
   - On patient QR: auto-navigate to that patient's MAR (by clicking patient list item)
*/

const searchBtn = document.getElementById("searchBtn");

let dlg = null;
let html5 = null;

/* ---------------------------
   Helpers
--------------------------- */
function sanitizeText(t){
  return String(t || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

function tryParsePatientQR(raw){
  const t = sanitizeText(raw);
  if(!t) return { ok:false, reason:"EMPTY" };

  let obj = null;
  try { obj = JSON.parse(t); } catch { return { ok:false, reason:"NOT_JSON" }; }

  // Expected:
  // { v:1, type:"patient", facility:"...", patient:{ name, room, mrn } }
  if(!obj || obj.type !== "patient" || !obj.patient) return { ok:false, reason:"NOT_PATIENT" };

  const p = obj.patient || {};
  const name = sanitizeText(p.name);
  const room = sanitizeText(p.room);
  const mrn  = sanitizeText(p.mrn);

  if(!name && !mrn) return { ok:false, reason:"NO_KEY" };

  return { ok:true, name, room, mrn, raw: obj };
}

function findPatientButton({ name, room, mrn }){
  const list = document.getElementById("patientList");
  if(!list) return null;

  const items = Array.from(list.querySelectorAll("button.item"));
  if(!items.length) return null;

  const n = sanitizeText(name);
  const r = sanitizeText(room);
  const m = sanitizeText(mrn);

  // 1) name startsWith 우선 (UI가 이름으로 시작하는 구조)
  if(n){
    let hit = items.find(b => sanitizeText(b.textContent).startsWith(n));
    if(!hit) hit = items.find(b => sanitizeText(b.textContent).includes(n));
    if(hit){
      // room/mrn이 있으면 더 정확히 맞춰보기
      const txt = sanitizeText(hit.textContent);
      if(r && !txt.includes(r)){
        const hit2 = items.find(b => sanitizeText(b.textContent).includes(n) && sanitizeText(b.textContent).includes(r));
        if(hit2) hit = hit2;
      }
      if(m && !txt.includes(m)){
        const hit3 = items.find(b => sanitizeText(b.textContent).includes(n) && sanitizeText(b.textContent).includes(m));
        if(hit3) hit = hit3;
      }
      return hit;
    }
  }

  // 2) MRN으로 찾기 (이름이 다를 때 대비)
  if(m){
    const hit = items.find(b => sanitizeText(b.textContent).includes(m));
    if(hit) return hit;
  }

  return null;
}

function navigateToPatientFromQR(raw){
  const parsed = tryParsePatientQR(raw);
  if(!parsed.ok){
    if(parsed.reason === "NOT_JSON") alert("환자 QR 파싱 실패 (JSON 아님).");
    else if(parsed.reason === "NOT_PATIENT") alert("환자 QR이 아닙니다.");
    else alert("환자 QR 인식 실패.");
    return false;
  }

  const btn = findPatientButton(parsed);
  if(!btn){
    alert(`환자 목록에서 찾지 못했습니다.\nname: ${parsed.name || "-"}\nmrn: ${parsed.mrn || "-"}`);
    return false;
  }

  // 기존 app.v2.mjs의 onclick 로직 그대로 타게 "클릭"한다
  btn.click();
  return true;
}

/* ---------------------------
   html5-qrcode loader
--------------------------- */
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

/* ---------------------------
   Dialog UI
--------------------------- */
function ensureDialog(){
  if(dlg) return;

  dlg = document.createElement("dialog");
  dlg.id = "searchDlg";
  dlg.innerHTML = `
    <div class="dlg-head">🔍 환자 검색</div>
    <div class="dlg-body">
      <div class="hint" id="searchStatus">
        스캐너로 환자 QR을 찍으세요. (기본) / 스캐너가 안되면 Camera 사용
      </div>

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
          <div class="hint">아래 입력칸에 포커스가 있으면 스캐너 입력이 들어옵니다. 스캔 후 Enter.</div>
          <input id="searchInput" placeholder="Scan patient QR here…" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <div class="hint" style="margin-top:6px;">스캔 성공 시 자동으로 해당 환자 MAR로 이동합니다.</div>
        </div>
      </div>
    </div>

    <div class="dlg-actions">
      <button class="btn secondary" id="searchClose">Close</button>
    </div>
  `;

  document.body.appendChild(dlg);

  // close
  dlg.querySelector("#searchClose").addEventListener("click", closeSearch);

  // scanner input default
  const input = dlg.querySelector("#searchInput");
  input.addEventListener("keydown", async (e) => {
    if(e.key !== "Enter") return;
    e.preventDefault();
    const v = input.value;
    input.value = "";
    const ok = navigateToPatientFromQR(v);
    if(ok){
      await stopCamera();
      closeSearch();
    }
  });

  // camera buttons
  dlg.querySelector("#searchCamStart").addEventListener("click", startCamera);
  dlg.querySelector("#searchCamStop").addEventListener("click", stopCamera);

  // when dialog closes, always stop camera
  dlg.addEventListener("close", () => {
    stopCamera();
  });
}

function openSearch(){
  ensureDialog();
  dlg.showModal();

  // scanner default focus
  const input = dlg.querySelector("#searchInput");
  setTimeout(() => input && input.focus(), 50);

  const statusEl = dlg.querySelector("#searchStatus");
  statusEl.textContent = "스캐너로 환자 QR을 찍으세요. (기본) / 스캐너가 안되면 Camera 사용";
}

function closeSearch(){
  try { dlg?.close(); } catch {}
}

/* ---------------------------
   Camera (html5-qrcode)
--------------------------- */
async function startCamera(){
  ensureDialog();

  const statusEl = dlg.querySelector("#searchStatus");
  const startBtn = dlg.querySelector("#searchCamStart");
  const stopBtn  = dlg.querySelector("#searchCamStop");

  await stopCamera(); // clean start

  statusEl.textContent = "카메라 시작 중…";
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
        const ok = navigateToPatientFromQR(decodedText);
        if(ok){
          statusEl.textContent = "환자 확인됨 → 이동 중…";
          await stopCamera();
          closeSearch();
        }
      },
      (_err) => {}
    );

    statusEl.textContent = "카메라 켜짐. 환자 QR을 비추세요…";
  }catch(err){
    const msg = err?.message || String(err);
    statusEl.textContent = "카메라 실패: " + msg;
    await stopCamera();
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

/* ---------------------------
   Wire button
--------------------------- */
if(searchBtn){
  searchBtn.addEventListener("click", openSearch);
} else {
  console.warn("search.v2.mjs: #searchBtn not found");
}
