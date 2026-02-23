/* qr.v2.mjs
   Handle MAR - QR Builder + Scan (integrated)
   - QR popup: patient QR (always on top) + batch QR generator + export
   - Scan popup: hardware scanner (keyboard wedge) + camera fallback
   - Scan workflow: patient QR -> within 10 minutes batch QR -> auto record meds
   - Duplicate: warns only; cancellation must be done by click/tap in MAR UI
*/

import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function waitForGlobals(){
  while(!(window.__MAR_FB__ && window.__MAR_FB__.auth && window.__MAR_FB__.db && window.MAR_APP)){
    await sleep(100);
  }
}

function safeText(s){ return (s==null) ? "" : String(s); }
function escapeHtml(s){
  s = safeText(s);
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
          .replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

function nowHHMM(){
  const d = new Date();
  return d.toTimeString().slice(0,5);
}
function minutesSinceMidnight(hhmm){
  const m = safeText(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  if(!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h*60 + mm;
}
function withinPlusMinusMinutes(targetHHMM, minutes=60){
  const t = minutesSinceMidnight(targetHHMM);
  const n = minutesSinceMidnight(nowHHMM());
  if(t==null || n==null) return true;
  return Math.abs(n - t) <= minutes;
}

function getInitialsFromEmail(email){
  const local = safeText(email).split("@")[0];
  const parts = local.split(/[.\-_]+/).filter(Boolean);
  const initials = parts.map(p=> (p[0]||"").toUpperCase()).join("");
  return (initials || local.slice(0,2).toUpperCase() || "NA").slice(0,4);
}

function normalizePatientKey(p){
  const name = safeText(p?.name).trim();
  const room = safeText(p?.room).trim();
  const mrn  = safeText(p?.mrn).trim();
  return `${name}||${room}||${mrn}`;
}

function buildPatientPayload({ facilityCode, patientName, patientRoom, patientMRN }){
  return JSON.stringify({
    v: 1,
    type: "patient",
    facility: facilityCode || null,
    patient: { name: patientName || null, room: patientRoom || null, mrn: patientMRN || null }
  });
}

function buildBatchPayload({ facilityCode, patientName, patientRoom, patientMRN, time, meds, batchId }){
  return JSON.stringify({
    v: 1,
    type: "batch",
    facility: facilityCode || null,
    patient: { name: patientName || null, room: patientRoom || null, mrn: patientMRN || null },
    time: time || null,
    meds: meds || [],
    batchId: batchId || null
  });
}

function groupMedsByTime(patientObj){
  const meds = (patientObj && patientObj.meds) ? patientObj.meds : {};
  const out = new Map();
  for(const medName of Object.keys(meds)){
    const times = Array.isArray(meds[medName]?.times) ? meds[medName].times : [];
    for(const t of times){
      if(!out.has(t)) out.set(t, []);
      out.get(t).push(medName);
    }
  }
  const entries = [...out.entries()].map(([t, arr])=>[t, arr.sort((a,b)=>a.localeCompare(b))]);
  entries.sort((a,b)=> a[0].localeCompare(b[0]));
  return entries;
}

/* ---------- QR Builder Popup ---------- */
function qrPopupHtml(){
  return `<!doctype html><html><head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <title>QR Builder</title>
  <style>
    :root{--bg:#0b0b0f;--panel:#13131a;--panel2:#1b1b25;--text:#f2f2f7;--muted:#a1a1aa;--grid:#2a2a35;--accent:#0a84ff;--warn:#ff453a;}
    *{box-sizing:border-box}
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial;background:var(--bg);color:var(--text);height:100vh;overflow:hidden;}
    .bar{display:flex;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid var(--grid);background:rgba(19,19,26,.95);gap:10px;}
    .title{font-weight:900}
    .btn{background:var(--accent);color:white;border:none;border-radius:10px;padding:10px 12px;font-weight:800;cursor:pointer;white-space:nowrap;}
    .btn.secondary{background:var(--panel2);border:1px solid var(--grid);color:var(--text);}
    .btn:disabled{opacity:.45;cursor:not-allowed;}
    .wrap{display:grid;grid-template-columns:1fr 1fr;height:calc(100vh - 56px);gap:12px;padding:12px;}
    .panel{background:var(--panel);border:1px solid var(--grid);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;}
    .panel .hdr{padding:10px 12px;border-bottom:1px solid var(--grid);display:flex;justify-content:space-between;align-items:center;gap:10px;}
    .panel .body{padding:12px;overflow:auto;flex:1;}
    .hint{color:var(--muted);font-size:12px;line-height:1.35;}
    .group{border:1px solid var(--grid);border-radius:12px;padding:10px;margin-bottom:10px;background:rgba(255,255,255,.03);}
    .gtitle{font-weight:900;display:flex;justify-content:space-between;align-items:center;gap:10px;}
    .med{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px dashed rgba(255,255,255,.08);}
    .med:last-child{border-bottom:none;}
    .chk{display:flex;align-items:center;gap:8px;min-width:0;}
    .chk input{transform:scale(1.15);}
    .medname{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .card{border:1px solid var(--grid);border-radius:14px;padding:10px;background:rgba(255,255,255,.03);margin-bottom:10px;display:flex;gap:10px;}
    .qrbox{width:170px;height:170px;background:white;border-radius:12px;display:flex;align-items:center;justify-content:center;overflow:hidden;}
    .meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;}
    .meta .line{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .meta .bold{color:var(--text);font-weight:900;}
    .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
    .smallbtn{padding:7px 10px;border-radius:10px;border:1px solid var(--grid);background:var(--panel2);color:var(--text);cursor:pointer;font-weight:800;}
    textarea{width:100%;min-height:90px;border-radius:12px;background:var(--panel2);border:1px solid var(--grid);color:var(--text);padding:10px;font-size:12px;outline:none;}
    .err{color:var(--warn);font-size:12px;white-space:pre-wrap;}
    .divider{height:1px;background:var(--grid);margin:10px 0;}
  </style>
  </head><body>
    <div class="bar">
      <div>
        <div class="title" id="qrTitle">QR Code</div>
        <div class="hint" id="qrSub"></div>
      </div>
      <div class="row">
        <button class="btn" id="btnMake">Batch QR 생성</button>
        <button class="btn secondary" id="btnExport" disabled>Export (JPG)</button>
        <button class="btn secondary" id="btnClose">나가기</button>
      </div>
    </div>

    <div class="wrap">
      <div class="panel">
        <div class="hdr">
          <div class="bold">약 선택 (시간별 Batch)</div>
          <button class="smallbtn" id="btnClear">Clear</button>
        </div>
        <div class="body" id="leftBody"></div>
      </div>

      <div class="panel">
        <div class="hdr">
          <div class="bold">생성된 QR</div>
          <div class="hint" id="countHint">0</div>
        </div>
        <div class="body" id="rightBody">
          <div class="hint">맨 위에 환자 고유 QR이 항상 표시됩니다. 아래는 생성한 Batch QR 입니다.</div>
          <div class="divider"></div>
          <div id="patientQrSlot"></div>
          <div class="divider"></div>
          <div class="err" id="err"></div>
          <div id="batchList"></div>
        </div>
      </div>
    </div>

    <script>
      (function(){
        const s=document.createElement('script');
        s.src='https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
        s.crossOrigin='anonymous';
        s.referrerPolicy='no-referrer';
        s.onload=()=>{ window.__QR_LIB__ = true; };
        s.onerror=()=>{ window.__QR_LIB__ = false; };
        document.head.appendChild(s);
      })();
    </script>
  </body></html>`;
}

function openQrPopup(){
  const w = window.open("", "_blank", "width=1100,height=780");
  if(!w) return null;
  w.document.open();
  w.document.write(qrPopupHtml());
  w.document.close();
  return w;
}

function renderQrIntoBox(win, boxEl, payload){
  boxEl.innerHTML = "";
  if(win.__QR_LIB__ !== true){
    const pre = win.document.createElement("div");
    pre.style.padding="10px"; pre.style.fontSize="12px"; pre.style.color="#000";
    pre.textContent = (win.__QR_LIB__===false) ? "QR lib blocked. Showing payload." : "Loading QR…";
    boxEl.appendChild(pre);
    let tries=0;
    const t = win.setInterval(()=>{
      tries++;
      if(win.__QR_LIB__===true && win.qrcode){
        win.clearInterval(t);
        renderQrIntoBox(win, boxEl, payload);
      }
      if(tries>=10) win.clearInterval(t);
    }, 200);
    return;
  }
  if(win.qrcode){
    try{
      const qr = win.qrcode(0,"M");
      qr.addData(payload);
      qr.make();
      const imgTag = qr.createImgTag(4,8);
      const div = win.document.createElement("div");
      div.innerHTML = imgTag;
      const img = div.querySelector("img");
      if(img){
        img.style.width="100%"; img.style.height="100%"; img.style.objectFit="contain";
        boxEl.appendChild(img);
        return;
      }
    }catch(_e){}
  }
  const pre=win.document.createElement("div");
  pre.style.padding="10px"; pre.style.fontSize="10px"; pre.style.color="#000"; pre.style.whiteSpace="pre-wrap";
  pre.textContent = payload;
  boxEl.appendChild(pre);
}

async function exportCardAsJpg(win, cardEl, fileName){
  const qrImg = cardEl.querySelector("img");
  if(qrImg && qrImg.src){
    const a = win.document.createElement("a");
    a.href = qrImg.src;
    a.download = fileName;
    a.click();
    return true;
  }
  const payload = cardEl.dataset.payload || "";
  const c = win.document.createElement("canvas");
  c.width = 900; c.height = 520;
  const ctx = c.getContext("2d");
  ctx.fillStyle="#ffffff"; ctx.fillRect(0,0,c.width,c.height);
  ctx.fillStyle="#000000"; ctx.font="20px Arial"; ctx.fillText("QR Payload", 20, 40);
  ctx.font="14px Arial";
  const lines = payload.match(/.{1,90}/g) || [payload];
  let y=70;
  for(const ln of lines.slice(0,25)){ ctx.fillText(ln,20,y); y+=20; }
  const dataUrl = c.toDataURL("image/jpeg", 0.92);
  const a = win.document.createElement("a");
  a.href = dataUrl;
  a.download = fileName;
  a.click();
  return true;
}

/* ---------- Scan Popup ---------- */
function scanPopupHtml(){
  return `<!doctype html><html><head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <title>Scan</title>
  <style>
    :root{--bg:#0b0b0f;--panel:#13131a;--panel2:#1b1b25;--text:#f2f2f7;--muted:#a1a1aa;--grid:#2a2a35;--accent:#0a84ff;--warn:#ff453a;--ok:#34c759;--due:#ffd60a;}
    *{box-sizing:border-box}
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial;background:var(--bg);color:var(--text);height:100vh;}
    .bar{display:flex;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid var(--grid);background:rgba(19,19,26,.95);gap:10px;}
    .title{font-weight:900}
    .btn{background:var(--accent);color:white;border:none;border-radius:10px;padding:10px 12px;font-weight:800;cursor:pointer;white-space:nowrap;}
    .btn.secondary{background:var(--panel2);border:1px solid var(--grid);color:var(--text);}
    .wrap{padding:12px;display:flex;flex-direction:column;gap:10px;}
    .card{background:var(--panel);border:1px solid var(--grid);border-radius:14px;padding:12px;}
    .hint{color:var(--muted);font-size:12px;line-height:1.35;}
    .err{color:var(--warn);font-size:12px;white-space:pre-wrap;}
    input{width:100%;padding:12px;border-radius:12px;background:var(--panel2);border:1px solid var(--grid);color:var(--text);outline:none;}
    #reader{width:100%;border-radius:14px;overflow:hidden;}
    .status{font-weight:900;}
    .ok{color:var(--ok);}
    .due{color:var(--due);}
  </style>
  </head><body>
    <div class="bar">
      <div>
        <div class="title">Scan</div>
        <div class="hint">순서: <b>환자 QR</b> → (10분 이내) <b>Batch QR</b></div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        <button class="btn secondary" id="btnCam">Camera</button>
        <button class="btn secondary" id="btnStop" disabled>Stop</button>
        <button class="btn secondary" id="btnClose">Close</button>
      </div>
    </div>

    <div class="wrap">
      <div class="card">
        <div class="status" id="ctxLine">Patient: <span class="due">not scanned</span></div>
        <div class="hint" id="ctxHint">환자 QR을 먼저 스캔하세요. (스캐너 또는 카메라)</div>
      </div>

      <div class="card">
        <div style="font-weight:900;margin-bottom:8px;">Scanner (무선/USB)</div>
        <div class="hint">스캐너는 키보드처럼 입력됩니다. 아래 입력창을 항상 선택해두세요.</div>
        <input id="scanInput" placeholder="scan here (auto-enter)" autocomplete="off" />
      </div>

      <div class="card">
        <div style="font-weight:900;margin-bottom:8px;">Camera (fallback)</div>
        <div class="hint">스캐너 고장 시 Camera 버튼을 눌러 스캔하세요.</div>
        <div id="reader"></div>
      </div>

      <div class="card">
        <div class="err" id="err"></div>
        <div class="hint" id="log"></div>
      </div>
    </div>

    <script>
      (function(){
        const s=document.createElement('script');
        s.src='https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
        s.onload=()=>{ window.__H5QR__ = true; };
        s.onerror=()=>{ window.__H5QR__ = false; };
        document.head.appendChild(s);
      })();
    </script>
  </body></html>`;
}

function openScanPopup(){
  const w = window.open("", "_blank", "width=680,height=860");
  if(!w) return null;
  w.document.open();
  w.document.write(scanPopupHtml());
  w.document.close();
  return w;
}

/* ---------- Role lookup ---------- */
async function getUserRole(auth, db){
  const u = auth.currentUser;
  if(!u) return null;
  try{
    const ref = doc(db, "users", u.uid);
    const snap = await getDoc(ref);
    if(snap.exists()){
      const role = safeText(snap.data()?.role).toLowerCase();
      return role || null;
    }
  }catch(e){
    console.warn("role lookup failed:", e);
  }
  return null;
}

/* ---------- Scan apply (main window) ---------- */
function makeScanApply(APP, auth){
  function findPatientByKey(key){
    const st = APP.getState();
    const pats = st?.patients || {};
    for(const name of Object.keys(pats)){
      const p = pats[name];
      const k = normalizePatientKey({ name, room: p?.room, mrn: p?.mrn });
      if(k === key) return { name, patient: p, state: st };
    }
    return null;
  }

  function isDuplicateBatch(patient, dayKey, batchId){
    if(!batchId) return false;
    const meds = patient?.meds || {};
    for(const medName of Object.keys(meds)){
      const hist = meds[medName]?.history?.[dayKey];
      if(!Array.isArray(hist)) continue;
      if(hist.some(x => x && x.batchId === batchId)) return true;
    }
    return false;
  }

  return async function applyBatch(payload){
    const facilityNow = APP.getFacilityCode ? APP.getFacilityCode() : null;
    if(payload?.facility && facilityNow && payload.facility !== facilityNow){
      return { ok:false, msg:`Facility mismatch (${payload.facility} ≠ ${facilityNow})` };
    }

    const key = normalizePatientKey(payload.patient);
    const found = findPatientByKey(key);
    if(!found){
      return { ok:false, msg:"Patient not found (name+room+MRN mismatch)" };
    }

    const { name, patient, state } = found;
    const today = new Date().toISOString().slice(0,10);
    const batchId = payload.batchId || null;

    // duplicate -> warn only (no cancellation by scan)
    if(isDuplicateBatch(patient, today, batchId)){
      return { ok:false, msg:"이미 투약됨 (duplicate). 취소는 MAR에서 클릭/터치로만 가능합니다." };
    }

    const initials = getInitialsFromEmail(auth.currentUser?.email || "");
    const status = payload.time && withinPlusMinusMinutes(payload.time, 60) ? "ok" : "late";
    const givenAt = nowHHMM();

    const meds = Array.isArray(payload.meds) ? payload.meds : [];
    for(const medName of meds){
      if(!patient?.meds?.[medName]) continue;
      patient.meds[medName].history = patient.meds[medName].history || {};
      patient.meds[medName].history[today] = patient.meds[medName].history[today] || [];
      patient.meds[medName].history[today].push({
        sched: payload.time || null,
        given: givenAt,
        status,
        initials,
        source: "QR_SCAN",
        batchId
      });
    }

    APP.setState(state);
    return { ok:true, msg: status==="ok" ? `Given ✔ (${name})` : `Given (late) ⚠ (${name})` };
  };
}

(async function main(){
  await waitForGlobals();

  const { auth, db } = window.__MAR_FB__;
  const APP = window.MAR_APP;

  const qrBtn = document.getElementById("qrBtn");
  const scanBtn = document.getElementById("scanBtn");

  // Expose for popup
  window.__HANDLE_SCAN__ = {
    applyBatch: makeScanApply(APP, auth),
  };

  async function refreshAccess(){
    const disableAll = ()=>{
      if(qrBtn) qrBtn.disabled = true;
      if(scanBtn) scanBtn.disabled = true;
    };

    if(!auth.currentUser){
      disableAll();
      return;
    }

    const role = await getUserRole(auth, db);
    const allowed = (role === "nurse" || role === "admin");

    if(qrBtn) qrBtn.disabled = !allowed;
    if(scanBtn) scanBtn.disabled = !allowed;
  }

  setInterval(refreshAccess, 1200);
  refreshAccess();

  /* QR popup */
  if(qrBtn){
    qrBtn.addEventListener("click", async ()=>{
      const w = openQrPopup();
      if(!w){ alert("팝업 차단됨. 허용 후 다시 시도"); return; }

      const role = await getUserRole(auth, db);
      if(!(role==="nurse" || role==="admin")){
        w.close(); alert("QR code 탭은 nurse/admin만 접근 가능합니다."); return;
      }

      const patientName = APP.getSelectedPatient ? APP.getSelectedPatient() : null;
      if(!patientName){ w.close(); alert("환자를 먼저 선택하세요."); return; }

      const st = APP.getState ? APP.getState() : null;
      const patient = st?.patients?.[patientName];
      if(!patient){ w.close(); alert("선택된 환자를 찾을 수 없습니다."); return; }

      const facilityCode = APP.getFacilityCode ? APP.getFacilityCode() : null;
      const room = safeText(patient.room).trim();
      const mrn  = safeText(patient.mrn).trim();

      await sleep(120);

      const $ = (id)=> w.document.getElementById(id);
      const leftBody = $("leftBody");
      const patientSlot = $("patientQrSlot");
      const batchList = $("batchList");
      const btnMake = $("btnMake");
      const btnExport = $("btnExport");
      const btnClose = $("btnClose");
      const btnClear = $("btnClear");
      const qrTitle = $("qrTitle");
      const qrSub = $("qrSub");
      const countHint = $("countHint");
      const errEl = $("err");

      const generated = [];

      qrTitle.textContent = `QR Code · ${patientName}`;
      qrSub.textContent = `${(room||"-")} | ${(mrn||"-")} · Facility: ${(facilityCode||"-")}`;

      // Patient QR (always)
      patientSlot.innerHTML = "";
      const patientPayload = buildPatientPayload({ facilityCode, patientName, patientRoom: room, patientMRN: mrn });

      const patientCard = w.document.createElement("div");
      patientCard.className = "card";
      patientCard.dataset.payload = patientPayload;

      const pbox = w.document.createElement("div");
      pbox.className = "qrbox";
      renderQrIntoBox(w, pbox, patientPayload);

      const pmeta = w.document.createElement("div");
      pmeta.className = "meta";
      pmeta.innerHTML = `
        <div class="row" style="justify-content:space-between;">
          <div class="bold">Patient QR</div>
          <button class="smallbtn" id="btnExportPatient">Export</button>
        </div>
        <div class="line"><span class="bold">${escapeHtml(patientName)}</span></div>
        <div class="line">Room: ${escapeHtml(room||"-")}</div>
        <div class="line">MRN: ${escapeHtml(mrn||"-")}</div>
        <div class="hint">환자 식별용 QR (항상 고정)</div>
      `;
      patientCard.appendChild(pbox);
      patientCard.appendChild(pmeta);
      patientSlot.appendChild(patientCard);

      const btnExportPatient = w.document.getElementById("btnExportPatient");
      if(btnExportPatient){
        btnExportPatient.onclick = async ()=>{
          const fileSafeName =
            (patientName + "_" + (mrn||"MRN") + "_" + (room||"ROOM") + "_PATIENT_QR")
              .replace(/[^\w\-]+/g,"_") + ".jpg";
          await exportCardAsJpg(w, patientCard, fileSafeName);
        };
      }

      // Left list
      leftBody.innerHTML = "";
      const groups = groupMedsByTime(patient);
      if(groups.length === 0){
        leftBody.innerHTML = `<div class="hint">등록된 약/시간이 없습니다. 먼저 +Med로 추가하세요.</div>`;
      }else{
        for(const [time, meds] of groups){
          const g = w.document.createElement("div");
          g.className = "group";
          const head = w.document.createElement("div");
          head.className = "gtitle";
          head.innerHTML = `<div>${escapeHtml(time)}</div><div class="hint">${escapeHtml(String(meds.length))} meds</div>`;
          g.appendChild(head);

          for(const medName of meds){
            const row = w.document.createElement("div");
            row.className = "med";
            const left = w.document.createElement("label");
            left.className = "chk";
            left.innerHTML = `<input type="checkbox" data-time="${escapeHtml(time)}" data-med="${escapeHtml(medName)}" />
                              <span class="medname">${escapeHtml(medName)}</span>`;
            row.appendChild(left);
            g.appendChild(row);
          }
          leftBody.appendChild(g);
        }
      }

      function updateExportEnabled(){
        const anyChecked = !!batchList.querySelector('input[type="checkbox"][data-export="1"]:checked');
        btnExport.disabled = !anyChecked;
        countHint.textContent = String(generated.length);
      }
      function clearLeftChecks(){
        leftBody.querySelectorAll('input[type="checkbox"][data-time]').forEach(cb=>cb.checked=false);
      }
      btnClear.onclick = ()=> clearLeftChecks();
      btnClose.onclick = ()=> w.close();

      btnMake.onclick = ()=>{
        errEl.textContent = "";
        const checked = [...leftBody.querySelectorAll('input[type="checkbox"][data-time]:checked')];
        if(checked.length === 0){ errEl.textContent = "왼쪽에서 약을 체크하세요."; return; }

        const map = new Map();
        for(const cb of checked){
          const t = cb.getAttribute("data-time") || "";
          const m = cb.getAttribute("data-med") || "";
          if(!map.has(t)) map.set(t, []);
          map.get(t).push(m);
        }

        for(const [time, meds] of [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0]))){
          const uniq = [...new Set(meds)].sort((a,b)=>a.localeCompare(b));
          if(uniq.length === 0) continue;

          const batchId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
          const payload = buildBatchPayload({
            facilityCode,
            patientName,
            patientRoom: room,
            patientMRN: mrn,
            time,
            meds: uniq,
            batchId
          });

          const id = batchId;
          generated.push({ id, time, meds: uniq, payload });

          const card = w.document.createElement("div");
          card.className = "card";
          card.dataset.id = id;
          card.dataset.payload = payload;

          const qrbox = w.document.createElement("div");
          qrbox.className = "qrbox";
          renderQrIntoBox(w, qrbox, payload);

          const meta = w.document.createElement("div");
          meta.className = "meta";
          meta.innerHTML = `
            <div class="row" style="justify-content:space-between;">
              <div class="bold">${escapeHtml(time)} batch</div>
              <label class="chk" style="justify-content:flex-end;">
                <input type="checkbox" data-export="1" data-id="${escapeHtml(id)}" />
                <span class="hint">Export</span>
              </label>
            </div>
            <div class="line"><span class="bold">Room</span>: ${escapeHtml(room||"-")} · <span class="bold">MRN</span>: ${escapeHtml(mrn||"-")}</div>
            <div class="line"><span class="bold">Meds</span>: ${escapeHtml(uniq.join(", "))}</div>
            <div class="hint">스캔 순서: <b>환자 QR</b> → (10분 이내) <b>Batch QR</b></div>
          `;

          const ta = w.document.createElement("textarea");
          ta.value = payload; ta.readOnly = true;
          meta.appendChild(ta);

          card.appendChild(qrbox);
          card.appendChild(meta);
          batchList.appendChild(card);
        }

        clearLeftChecks();
        updateExportEnabled();

        batchList.querySelectorAll('input[type="checkbox"][data-export="1"]').forEach(cb=>{
          cb.onchange = ()=> updateExportEnabled();
        });
      };

      btnExport.onclick = async ()=>{
        errEl.textContent = "";
        const selected = [...batchList.querySelectorAll('input[type="checkbox"][data-export="1"]:checked')];
        if(selected.length === 0){ btnExport.disabled = true; return; }

        let okCount = 0;
        for(const cb of selected){
          const id = cb.getAttribute("data-id") || "";
          const esc = (w.CSS && w.CSS.escape) ? w.CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
          const card = batchList.querySelector(`.card[data-id="${esc}"]`);
          if(!card) continue;

          const timeLine = safeText(card.querySelector(".bold")?.textContent || "");
          const time = timeLine.replace(" batch","").trim();
          const fileSafeName =
            (patientName + "_" + (mrn||"MRN") + "_" + time + "_batch").replace(/[^\w\-]+/g,"_") + ".jpg";

          await exportCardAsJpg(w, card, fileSafeName);
          okCount++;
        }

        errEl.textContent = okCount ? `Export 완료: ${okCount}개` : "Export 실패";
        selected.forEach(cb=>cb.checked=false);
        updateExportEnabled();
      };

      updateExportEnabled();
    });
  }

  /* Scan popup */
  if(scanBtn){
    scanBtn.addEventListener("click", async ()=>{
      const w = openScanPopup();
      if(!w){ alert("팝업 차단됨. 허용 후 다시 시도"); return; }

      const role = await getUserRole(auth, db);
      if(!(role==="nurse" || role==="admin")){
        w.close(); alert("Scan 탭은 nurse/admin만 접근 가능합니다."); return;
      }

      await sleep(150);

      const $ = (id)=> w.document.getElementById(id);
      const scanInput = $("scanInput");
      const ctxLine = $("ctxLine");
      const ctxHint = $("ctxHint");
      const errEl = $("err");
      const logEl = $("log");
      const btnCam = $("btnCam");
      const btnStop = $("btnStop");
      const btnClose = $("btnClose");

      let ctx = null; // { key, expiresAt, patientObj }
      let scannerTimer = null;
      let camera = null;

      function setErr(msg){ errEl.textContent = msg || ""; }
      function setLog(msg){ logEl.textContent = msg || ""; }

      function renderCtx(){
        if(!ctx){
          ctxLine.innerHTML = `Patient: <span class="due">not scanned</span>`;
          ctxHint.textContent = "환자 QR을 먼저 스캔하세요. (스캐너 또는 카메라)";
          return;
        }
        const leftMs = ctx.expiresAt - Date.now();
        const leftMin = Math.max(0, Math.ceil(leftMs/60000));
        ctxLine.innerHTML = `Patient: <span class="ok">${escapeHtml(ctx.patientObj.name)}</span> (${escapeHtml(ctx.patientObj.room)} / ${escapeHtml(ctx.patientObj.mrn)})`;
        ctxHint.textContent = `유효시간: ${leftMin}분 남음. 이제 Batch QR을 스캔하세요.`;
      }

      function ctxValid(){ return !!ctx && Date.now() <= ctx.expiresAt; }

      async function handleDecoded(text){
        setErr("");
        const raw = safeText(text).trim();
        if(!raw) return;

        let payload = null;
        try{ payload = JSON.parse(raw); }catch(_e){
          setErr("QR 파싱 실패 (JSON 아님)");
          return;
        }

        if(payload?.v !== 1){ setErr("지원하지 않는 QR 버전"); return; }

        if(payload?.facility){
          const facilityNow = APP.getFacilityCode ? APP.getFacilityCode() : null;
          if(facilityNow && payload.facility !== facilityNow){
            setErr(`Facility mismatch (${payload.facility} ≠ ${facilityNow})`);
            return;
          }
        }

        if(payload.type === "patient"){
          const p = payload.patient || {};
          if(!safeText(p.name).trim() || !safeText(p.room).trim() || !safeText(p.mrn).trim()){
            setErr("환자 QR 형식 오류 (name/room/mrn 필요)");
            return;
          }
          ctx = {
            key: normalizePatientKey(p),
            expiresAt: Date.now() + 10*60*1000,
            patientObj: { name: safeText(p.name).trim(), room: safeText(p.room).trim(), mrn: safeText(p.mrn).trim() }
          };
          renderCtx();
          setLog("Patient verified ✔");
          return;
        }

        if(payload.type === "batch"){
          if(!ctxValid()){
            ctx = null;
            renderCtx();
            setErr("환자 QR 유효시간 만료. 다시 환자 QR을 스캔하세요.");
            return;
          }

          const key = normalizePatientKey(payload.patient);
          if(key !== ctx.key){
            setErr("Patient mismatch (name+room+MRN 불일치)");
            return;
          }

          const res = await window.opener.__HANDLE_SCAN__.applyBatch(payload);
          if(res.ok) setLog(res.msg);
          else setErr(res.msg);
          return;
        }

        setErr("알 수 없는 QR type");
      }

      scanInput.focus();
      scanInput.addEventListener("keydown", (e)=>{
        if(e.key === "Enter"){
          e.preventDefault();
          const v = scanInput.value;
          scanInput.value = "";
          handleDecoded(v);
        }
      });

      scannerTimer = w.setInterval(()=>{
        if(w.document.activeElement !== scanInput) scanInput.focus();
        if(ctx && !ctxValid()){
          ctx = null;
          renderCtx();
          setErr("환자 QR 유효시간 만료. 다시 환자 QR을 스캔하세요.");
        }
      }, 800);

      async function startCamera(){
        setErr("");
        if(w.__H5QR__ === false){
          setErr("Camera library load failed (html5-qrcode).");
          return;
        }
        let tries=0;
        while(!w.Html5Qrcode){
          await sleep(120);
          tries++;
          if(tries>40){ setErr("Camera 준비 실패"); return; }
        }
        try{
          camera = new w.Html5Qrcode("reader");
          await camera.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: 250 },
            async (decodedText)=>{ await handleDecoded(decodedText); }
          );
          btnStop.disabled = false;
          setLog("Camera scanning started");
        }catch(e){
          console.error(e);
          setErr("Camera start failed. 권한/카메라 확인.");
        }
      }

      async function stopCamera(){
        if(!camera) return;
        try{ await camera.stop(); await camera.clear(); }catch(_e){}
        camera = null;
        btnStop.disabled = true;
        setLog("Camera stopped");
      }

      btnCam.onclick = ()=> startCamera();
      btnStop.onclick = ()=> stopCamera();
      btnClose.onclick = async ()=>{
        try{ await stopCamera(); }catch(_e){}
        if(scannerTimer) w.clearInterval(scannerTimer);
        w.close();
      };

      renderCtx();
    });
  }
})();
