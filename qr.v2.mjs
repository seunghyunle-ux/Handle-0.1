/* qr.v2.mjs
   QR Batch Builder (opens new window)
   - nurse/admin only (social worker blocked)
   - left: meds grouped by time with checkboxes
   - right: generated QR batches with select + export JPG
*/

import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function waitForGlobals(){
  let tries = 0;
  while(true){
    const ok = window.__MAR_FB__ && window.__MAR_FB__.auth && window.__MAR_FB__.db && window.MAR_APP;
    if(ok) return;
    tries++;
    if(tries % 20 === 0){
      console.warn("QR: waiting for hooks...", "MAR_APP:", !!window.MAR_APP, "__MAR_FB__:", !!window.__MAR_FB__);
    }
    await sleep(100);
  }
}

function escapeHtml(s){
  s = (s === null || s === undefined) ? "" : String(s);
  return s
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

function safeText(s){ return (s==null) ? "" : String(s); }

function groupMedsByTime(patientObj){
  const meds = (patientObj && patientObj.meds) ? patientObj.meds : {};
  const out = new Map(); // time -> array of medNames
  for(const medName of Object.keys(meds)){
    const times = Array.isArray(meds[medName].times) ? meds[medName].times : [];
    for(const t of times){
      if(!out.has(t)) out.set(t, []);
      out.get(t).push(medName);
    }
  }
  // sort
  const entries = [...out.entries()].map(([t, arr])=>[t, arr.sort((a,b)=>a.localeCompare(b))]);
  entries.sort((a,b)=> a[0].localeCompare(b[0]));
  return entries;
}

function buildPayload({ facilityCode, patientName, patientRoom, patientMRN, time, meds }){
  // QR에 들어갈 문자열: 너무 길어질 수 있으니 1차는 JSON compact
  // 필요하면 나중에 "MRN|time|med1;med2" 같은 포맷으로 바꿀 수 있음
  const payload = {
    v: 1,
    facility: facilityCode || null,
    patient: {
      name: patientName || null,     // HIPAA 민감하면 여기 빼도 됨
      room: patientRoom || null,
      mrn: patientMRN || null
    },
    time: time || null,
    meds: meds || []
  };
  return `${location.origin}${location.pathname}?payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

// Minimal QR encoder (uses public CDN library if available)
// We'll inject a tiny QR generator script (qrcode-generator) into the popup.
// If blocked, we fallback to "text only" (still exportable as image).
function popupHtmlShell(){
  return `<!doctype html><html><head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <title>QR Code</title>
  <style>
    :root{
      --bg:#0b0b0f; --panel:#13131a; --panel2:#1b1b25;
      --text:#f2f2f7; --muted:#a1a1aa; --grid:#2a2a35;
      --accent:#0a84ff; --warn:#ff453a;
    }
    *{box-sizing:border-box}
    body{margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial; background:var(--bg); color:var(--text); height:100vh; overflow:hidden;}
    .bar{display:flex; align-items:center; justify-content:space-between; padding:12px; border-bottom:1px solid var(--grid); background:rgba(19,19,26,.95); gap:10px;}
    .title{font-weight:900}
    .btn{background:var(--accent); color:white; border:none; border-radius:10px; padding:10px 12px; font-weight:800; cursor:pointer; white-space:nowrap;}
    .btn.secondary{background:var(--panel2); border:1px solid var(--grid); color:var(--text);}
    .btn:disabled{opacity:.45; cursor:not-allowed;}
    .wrap{display:grid; grid-template-columns: 1fr 1fr; height: calc(100vh - 56px); gap:12px; padding:12px;}
    .panel{background:var(--panel); border:1px solid var(--grid); border-radius:14px; overflow:hidden; display:flex; flex-direction:column;}
    .panel .hdr{padding:10px 12px; border-bottom:1px solid var(--grid); display:flex; justify-content:space-between; align-items:center; gap:10px;}
    .panel .body{padding:12px; overflow:auto; flex:1;}
    .hint{color:var(--muted); font-size:12px; line-height:1.35;}
    .group{border:1px solid var(--grid); border-radius:12px; padding:10px; margin-bottom:10px; background:rgba(255,255,255,.03);}
    .gtitle{font-weight:900; display:flex; justify-content:space-between; align-items:center; gap:10px;}
    .med{display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 0; border-bottom:1px dashed rgba(255,255,255,.08);}
    .med:last-child{border-bottom:none;}
    .chk{display:flex; align-items:center; gap:8px; min-width:0;}
    .chk input{transform: scale(1.15);}
    .medname{white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
    .card{border:1px solid var(--grid); border-radius:14px; padding:10px; background:rgba(255,255,255,.03); margin-bottom:10px; display:flex; gap:10px;}
    .qrbox{width:170px; height:170px; background:white; border-radius:12px; display:flex; align-items:center; justify-content:center; overflow:hidden;}
    .meta{flex:1; min-width:0; display:flex; flex-direction:column; gap:6px;}
    .meta .line{color:var(--muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
    .meta .bold{color:var(--text); font-weight:900;}
    .row{display:flex; align-items:center; gap:10px; flex-wrap:wrap;}
    .smallbtn{padding:7px 10px; border-radius:10px; border:1px solid var(--grid); background:var(--panel2); color:var(--text); cursor:pointer; font-weight:800;}
    textarea{width:100%; min-height:90px; border-radius:12px; background:var(--panel2); border:1px solid var(--grid); color:var(--text); padding:10px; font-size:12px; outline:none;}
    .err{color:var(--warn); font-size:12px; white-space:pre-wrap;}
  </style>
  </head><body>
    <div class="bar">
      <div>
        <div class="title" id="qrTitle">QR Code</div>
        <div class="hint" id="qrSub"></div>
      </div>
      <div class="row">
        <button class="btn" id="btnMake">QR 코드 생성</button>
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
        <div class="body" id="leftBody">
          <div class="hint">왼쪽에서 같은 시간대 약을 체크하고, 위의 “QR 코드 생성”을 누르세요.</div>
        </div>
      </div>

      <div class="panel">
        <div class="hdr">
          <div class="bold">생성된 QR</div>
          <div class="hint" id="countHint">0</div>
        </div>
        <div class="body" id="rightBody">
          <div id="patientQrCard"></div>
          <div class="hint">QR이 여기 생성됩니다. Export할 항목을 체크하세요.</div>
          <div class="err" id="err"></div>
        </div>
      </div>
    </div>

    <!-- QR generator library (small). If CDN blocked, we will fallback. -->
    <script>
      // Load qrcode-generator from CDN. If it fails, we still show payload text.
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

function openPopup(){
  // Blob URL로 팝업을 열면 document.write 이슈를 완전히 피할 수 있음
  const html = popupHtmlShell();
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);

  const w = window.open(url, "_blank", "width=1100,height=780");
  if(!w) return null;

  // 메모리 정리 (팝업이 로드된 뒤 지워도 됨)
  setTimeout(()=>{ try{ URL.revokeObjectURL(url); }catch(_e){} }, 10_000);

  return w;
}

function dataUrlToBlob(dataUrl){
  const [head, b64] = dataUrl.split(",");
  const mime = /data:(.*?);base64/.exec(head)?.[1] || "image/jpeg";
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
}

// Render QR into a white box using library if available; else show text
function renderQrIntoBox(win, boxEl, payload){
  boxEl.innerHTML = "";
  if(win.__QR_LIB__ && win.qrcode){
    try{
      const qr = win.qrcode(0, "M"); // auto type, medium error correction
      qr.addData(payload);
      qr.make();
      // qr.createImgTag(cellSize, margin)
      const imgTag = qr.createImgTag(4, 8);
      // Insert generated img
      const div = win.document.createElement("div");
      div.innerHTML = imgTag;
      const img = div.querySelector("img");
      if(img){
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = "contain";
        boxEl.appendChild(img);
        return;
      }
    }catch(_e){
      // fallthrough
    }
  }
  // fallback: show payload shortened
  const pre = win.document.createElement("div");
  pre.style.padding = "10px";
  pre.style.fontSize = "10px";
  pre.style.color = "#000";
  pre.style.whiteSpace = "pre-wrap";
  pre.textContent = payload;
  boxEl.appendChild(pre);
}

async function exportCardAsJpg(win, cardEl, fileName){
  // Uses canvas by drawing the QR <img> + some text.
  // For simplicity, we capture only the QR image area as JPG if available.
  const qrImg = cardEl.querySelector("img");
  if(qrImg && qrImg.src){
    // Download QR img directly
    const a = win.document.createElement("a");
    a.href = qrImg.src;
    a.download = fileName;
    a.click();
    return true;
  }

  // Fallback: render card text to canvas (rough)
  const payload = cardEl.dataset.payload || "";
  const c = win.document.createElement("canvas");
  c.width = 900; c.height = 520;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0,0,c.width,c.height);
  ctx.fillStyle = "#000000";
  ctx.font = "20px Arial";
  ctx.fillText("QR Payload", 20, 40);
  ctx.font = "14px Arial";
  const lines = payload.match(/.{1,90}/g) || [payload];
  let y = 70;
  for(const ln of lines.slice(0, 25)){
    ctx.fillText(ln, 20, y);
    y += 20;
  }
  const dataUrl = c.toDataURL("image/jpeg", 0.92);
  const a = win.document.createElement("a");
  a.href = dataUrl;
  a.download = fileName;
  a.click();
  return true;
}

async function getUserRole(auth, db){
  const u = auth.currentUser;
  if(!u) return null;

  // Try users/{uid}.role first
  try{
    const ref = doc(db, "users", u.uid);
    const snap = await getDoc(ref);
    if(snap.exists()){
      const v = snap.data() || {};
      const role = safeText(v.role).toLowerCase();
      if(role) return role;
    }
  }catch(e){
    console.warn("QR: role lookup users/{uid} failed:", e);
  }

  // Fallback: allow if email includes ".local" and nurse id pattern? (optional)
  // For safety: default deny
  return null;
}

(async function main(){
  await waitForGlobals();

  const { auth, db } = window.__MAR_FB__;
  const APP = window.MAR_APP;

  const qrBtn = document.getElementById("qrBtn");
  if(!qrBtn){
    console.warn("QR: #qrBtn not found");
    return;
  }

  async function refreshQrButtonAccess(){
    // default disabled until allowed
    qrBtn.disabled = true;

    if(!auth.currentUser){
      qrBtn.disabled = true;
      return;
    }

    const role = await getUserRole(auth, db);
    const allowed = (role === "nurse" || role === "admin");
    qrBtn.disabled = !allowed;

    if(!allowed){
      qrBtn.title = "QR code: nurse/admin만 접근 가능";
    }else{
      qrBtn.title = "Open QR batch builder";
    }
  }

  // Refresh access on interval (simple + robust)
  setInterval(refreshQrButtonAccess, 1200);
  refreshQrButtonAccess();

  qrBtn.addEventListener("click", async ()=>{
    // access re-check
    const role = await getUserRole(auth, db);
    if(!(role === "nurse" || role === "admin")){
      alert("QR code 탭은 nurse/admin만 접근 가능합니다.");
      return;
    }

    const patientName = APP.getSelectedPatient ? APP.getSelectedPatient() : null;
    if(!patientName){
      alert("환자를 먼저 선택하세요.");
      return;
    }

    const st = APP.getState();
    const patient = st && st.patients ? st.patients[patientName] : null;
    if(!patient){
      alert("선택된 환자를 찾을 수 없습니다.");
      return;
    }

    const facilityCode = APP.getFacilityCode ? APP.getFacilityCode() : null;
    const room = safeText(patient.room).trim();
    const mrn  = safeText(patient.mrn).trim();

    const w = openPopup();
    if(!w){
      alert("팝업이 차단되었습니다. 브라우저에서 팝업 허용 후 다시 시도하세요.");
      return;
    }

    // Wait for popup DOM ready
    await sleep(80);

    const $ = (id)=> w.document.getElementById(id);
    const leftBody = $("leftBody");
    const rightBody = $("rightBody");
    const patientQrCard = $("patientQrCard");

// 환자 고유 QR (이름+방+MRN) 항상 표시
(function renderPatientIdQr(){
  if(!patientQrCard) return;

  const patientPayload = JSON.stringify({
    v: 1,
    type: "patient",
    facility: facilityCode || null,
    patient: {
      name: patientName || null,
      room: room || null,
      mrn: mrn || null
    }
  });

  const card = w.document.createElement("div");
  card.className = "card";
  card.dataset.id = "patient_id";
  card.dataset.payload = patientPayload;

  const qrbox = w.document.createElement("div");
  qrbox.className = "qrbox";
  renderQrIntoBox(w, qrbox, patientPayload);

  const meta = w.document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `
    <div class="row" style="justify-content:space-between;">
      <div class="bold">Patient ID</div>
      <label class="chk" style="justify-content:flex-end;">
        <input type="checkbox" data-export="1" data-id="patient_id" />
        <span class="hint">Export</span>
      </label>
    </div>
    <div class="line"><span class="bold">Name</span>: ${escapeHtml(patientName)}</div>
    <div class="line"><span class="bold">Room</span>: ${escapeHtml(room||"-")} · <span class="bold">MRN</span>: ${escapeHtml(mrn||"-")}</div>
    <div class="hint">환자 팔찌/환자 선택용 QR</div>
  `;

  const ta = w.document.createElement("textarea");
  ta.value = patientPayload;
  ta.readOnly = true;
  meta.appendChild(ta);

  card.appendChild(qrbox);
  card.appendChild(meta);

  patientQrCard.innerHTML = "";
  patientQrCard.appendChild(card);

  // export enable 업데이트 연결
  const cb = card.querySelector('input[type="checkbox"][data-export="1"]');
  if(cb) cb.onchange = ()=> updateExportEnabled();
})();
    const btnMake = $("btnMake");
    const btnExport = $("btnExport");
    const btnClose = $("btnClose");
    const btnClear = $("btnClear");
    const qrTitle = $("qrTitle");
    const qrSub = $("qrSub");
    const countHint = $("countHint");
    const errEl = $("err");

    const generated = []; // { id, time, meds, payload, createdAt }

    qrTitle.textContent = `QR Code · ${patientName}`;
    qrSub.textContent = `${(room||"-")} | ${(mrn||"-")} · Facility: ${(facilityCode||"-")}`;

    // Build left list grouped by time
    const groups = groupMedsByTime(patient);
    leftBody.innerHTML = "";

    if(groups.length === 0){
      leftBody.innerHTML = `<div class="hint">등록된 약/시간이 없습니다. 먼저 +Med로 추가하세요.</div>`;
    }else{
      for(const [time, meds] of groups){
        const g = w.document.createElement("div");
        g.className = "group";
        g.dataset.time = time;

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
      const anyChecked = !!(rightBody && rightBody.querySelector('input[type="checkbox"][data-export="1"]:checked'));
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

      // Collect checked meds grouped by time
      const checked = [...leftBody.querySelectorAll('input[type="checkbox"][data-time]:checked')];
      alert("checked count = " + checked.length);
      if(checked.length === 0){
        errEl.textContent = "왼쪽에서 약을 체크하세요.";
        return;
      }

      const map = new Map(); // time -> meds
      for(const cb of checked){
        const t = cb.getAttribute("data-time") || "";
        const m = cb.getAttribute("data-med") || "";
        if(!map.has(t)) map.set(t, []);
        map.get(t).push(m);
      }

      // Create one batch per time
      for(const [time, meds] of [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0]))){
        const uniq = [...new Set(meds)].sort((a,b)=>a.localeCompare(b));
        if(uniq.length === 0) continue;

        const payload = buildPayload({
          facilityCode,
          patientName,
          patientRoom: room,
          patientMRN: mrn,
          time,
          meds: uniq
        });

        const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        generated.push({ id, time, meds: uniq, payload, createdAt: Date.now() });

        // Render card
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
          <div class="hint">Payload는 아래에 표시(검사용)</div>
        `;

        const ta = w.document.createElement("textarea");
        ta.value = payload;
        ta.readOnly = true;

        meta.appendChild(ta);

        card.appendChild(qrbox);
        card.appendChild(meta);

        rightBody.appendChild(card);
      }

      clearLeftChecks();
      updateExportEnabled();

      // Attach listener for export checks
      rightBody.querySelectorAll('input[type="checkbox"][data-export="1"]').forEach(cb=>{
        cb.onchange = ()=> updateExportEnabled();
      });
    };

    btnExport.onclick = async ()=>{
      errEl.textContent = "";

      const selected = [...rightBody.querySelectorAll('input[type="checkbox"][data-export="1"]:checked')];
      if(selected.length === 0){
        btnExport.disabled = true;
        return;
      }

      // Export each selected QR as jpg
      let okCount = 0;
      for(const cb of selected){
        const id = cb.getAttribute("data-id");
        const card = rightBody.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
        if(!card) continue;

        const time = safeText(card.querySelector(".bold")?.textContent || "").replace(" batch","");
        const fileSafeName = (patientName + "_" + (mrn||"MRN") + "_" + time + "_batch").replace(/[^\w\-]+/g,"_") + ".jpg";
        try{
          await exportCardAsJpg(w, card, fileSafeName);
          okCount++;
        }catch(e){
          console.error("QR export error:", e);
        }
      }

      errEl.textContent = okCount ? `Export 완료: ${okCount}개` : "Export 실패";
      // uncheck after export
      selected.forEach(cb=>cb.checked=false);
      updateExportEnabled();
    };

    // initial right side count
    updateExportEnabled();
  });

})();



/* ===========================
   Scan (camera + scanner) UI
   - Patient QR (name+room+mrn) -> valid for 10 minutes
   - Then Batch QR -> records as given
   - Duplicate batch -> warning modal, proceed only by click/touch
=========================== */

async function ensureHtml5Qrcode(){
  if(window.Html5Qrcode) return window.Html5Qrcode;
  await new Promise((resolve,reject)=>{
    const s = document.createElement("script");
    s.src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
    s.onload = ()=>resolve();
    s.onerror = (e)=>reject(e);
    document.head.appendChild(s);
  });
  return window.Html5Qrcode;
}

function parsePayload(raw){
  if(!raw) return null;

  // normalize to string
  let t = String(raw).trim();
t = t.replace(/[\u0000-\u001F\u007F]/g, "").trim();
if(t.startsWith("{") && t.includes('\\"')) {
  t = t.replace(/\\+"/g, '"').replace(/\\\\/g, "\\");
}

  // 1) If it's a URL, try to extract payload/data/json param
  try{
    if(/^https?:\/\//i.test(t)){
      const u = new URL(t);
      t = u.searchParams.get("payload")
       || u.searchParams.get("data")
       || u.searchParams.get("json")
       || u.hash?.slice(1)
       || t;
      t = String(t).trim();
    }
  }catch(_e){ /* ignore */ }

  // 2) Try URI decode (handles %7B...%7D)
  try{
    const dec = decodeURIComponent(t);
    if(dec && dec !== t) t = dec.trim();
  }catch(_e){ /* ignore */ }

  // 3) If wrapped in quotes ( "\"{...}\"" ), unwrap by parsing once
  //    and if result is string, parse again later
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch { return null; }
  };

  // 4) Base64 support: b64:xxxx
  if(/^b64:/i.test(t)){
    try{
      const b = t.slice(4).trim();
      t = atob(b).trim();
    }catch(_e){ /* ignore */ }
  }

  // 5) If contains a JSON object somewhere inside, extract {...}
  //    (e.g., "QR: {...}" )
  if(!t.startsWith("{")){
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if(i >= 0 && j > i) t = t.slice(i, j+1).trim();
  }

  // 6) Parse JSON (1~2 passes)
  t = t.replace(/[\u0000-\u001F\u007F]/g, "").trim();
if(t.startsWith("{") && t.includes('\\"')) {
  t = t.replace(/\\+"/g, '"').replace(/\\\\/g, "\\");
}
   
  let o = tryParse(t);
  if(typeof o === "string") o = tryParse(o);

  if(o && typeof o === "object"){
    // infer type if missing
    if(!o.type){
      if(o.patient && (o.meds || o.time)) o.type = "batch";
      else if(o.patient) o.type = "patient";
    }
    return o;
  }

  // 7) Fallback: plain MRN (digits) as patient
  const mrn = String(raw).trim();
  if(/^\d{4,}$/.test(mrn)){
    return { type:"patient", patient:{ name:"", room:"", mrn } };
  }

  return null;
}

function patientKey(p){
  if(!p) return "";
  return `${String(p.name||"").trim()}|${String(p.room||"").trim()}|${String(p.mrn||"").trim()}`;
}

function nowHHMM(){
  const d = new Date();
  return d.toTimeString().slice(0,5);
}
function todayKey(){
  return new Date().toISOString().slice(0,10);
}
function hashStr(s){
  try{
    return crypto && crypto.subtle ? null : null;
  }catch(_e){}
  return "h_" + (String(s||"").length) + "_" + (Math.random().toString(16).slice(2));
}

function getBatchId(payload, raw){
  if(payload && payload.batchId) return String(payload.batchId);
  // stable hash fallback (not cryptographic)
  let str = raw || JSON.stringify(payload||{});
  let h = 0;
  for(let i=0;i<str.length;i++){
    h = ((h<<5)-h) + str.charCodeAt(i);
    h |= 0;
  }
  return "b" + Math.abs(h);
}

function setStatus(el, msg){
  if(!el) return;
  el.textContent = msg;
}

function showClickModal(message){
  // must be dismissable only by click/touch
  return new Promise((resolve)=>{
    const dlg = document.createElement("dialog");
    dlg.style.maxWidth = "560px";
    dlg.innerHTML = `
      <div class="dlg-head">Warning</div>
      <div class="dlg-body"><div class="hint">${escapeHtml(message)}</div></div>
      <div class="dlg-actions">
        <button class="btn secondary" id="mCancel">Cancel</button>
        <button class="btn" id="mProceed">Proceed</button>
      </div>
    `;
    document.body.appendChild(dlg);

    // prevent Enter key confirming
    dlg.addEventListener("keydown", (e)=>{
      if(e.key === "Enter"){ e.preventDefault(); e.stopPropagation(); }
    });

    dlg.querySelector("#mCancel").addEventListener("click", ()=>{
      dlg.close("cancel");
      dlg.remove();
      resolve(false);
    });
    dlg.querySelector("#mProceed").addEventListener("click", ()=>{
      dlg.close("proceed");
      dlg.remove();
      resolve(true);
    });

    dlg.showModal();
  });
}

async function initScanUI(){
  const scanBtn = document.getElementById("scanBtn");
  const scanDlg = document.getElementById("scanDlg");
  if(!scanBtn || !scanDlg) return;

  async function refreshScanButtonAccess(){
    try{
      const role = await getUserRole();
      const allowed = (role === "admin" || role === "nurse");
      scanBtn.disabled = !allowed;
      scanBtn.title = allowed ? "Open Scan" : "Scan: nurse/admin만 접근 가능";
    }catch(e){
  scanBtn.disabled = false;
  scanBtn.title = "Open Scan";
    }
  }
  setTimeout(refreshScanButtonAccess, 0);

  const scanStatus = document.getElementById("scanStatus");
  const scanInput = document.getElementById("scanInput");
  const scanCloseBtn = document.getElementById("scanCloseBtn");

  const camStartBtn = document.getElementById("camStartBtn");
  const camStopBtn  = document.getElementById("camStopBtn");
  const camNextBtn  = document.getElementById("camNextBtn");
  const scanReader  = document.getElementById("scanReader");

  // context
  const ctx = {
    mode: "patient",              // patient -> batch
    patient: null,
    patientSetAt: 0,
    lastBatchId: null,
    lastBatchAt: 0
  };

  function patientExpired(){
    return !ctx.patient || (Date.now() - ctx.patientSetAt) > (10*60*1000);
  }

  function resetCtx(){
    ctx.mode = "patient";
    ctx.patient = null;
    ctx.patientSetAt = 0;
    setStatus(scanStatus, "환자 QR을 스캔하세요.");
    camNextBtn.disabled = true;
  }

  let camera = null;
  let cameraRunning = false;

  // Stabilize scanning: require same decode twice before accepting
  let __candidateText = "";
  let __candidateAt = 0;
  let __acceptLock = false;

  async function startCamera(){
    if(cameraRunning) return;
    __candidateText = "";
    __candidateAt = 0;
    __acceptLock = false;
    const Html5Qrcode = await ensureHtml5Qrcode();
    camera = camera || new Html5Qrcode(scanReader.id);
    setStatus(scanStatus, ctx.mode === "patient" ? "카메라 스캔 중… (환자 QR)" : "카메라 스캔 중… (Batch QR)");
    cameraRunning = true;
    camStartBtn.disabled = true;
    camStopBtn.disabled = false;
    camNextBtn.disabled = true;

    await camera.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 250 },
      async (decodedText)=>{
        if(__acceptLock) return;

        const t = String(decodedText || "").trim();
        const now = Date.now();

        // Accept only when the same content is seen twice within ~900ms.
        // This prevents flicker caused by false/partial decodes.
        if(t && t === __candidateText && (now - __candidateAt) <= 900){
          __acceptLock = true;
          try{
            await stopCamera(true);
            await handleDecoded(t, "camera");
            camNextBtn.disabled = false; // acts like "찰칵/다음"
          } finally {
            // small delay before allowing a new accept (in case camera restarts quickly)
            setTimeout(()=>{ __acceptLock = false; }, 300);
          }
          return;
        }

        // First sighting: keep camera running, just store candidate.
        __candidateText = t;
        __candidateAt = now;
        setStatus(scanStatus, "QR 조준 유지… (확인중)");
      },
      (_err)=>{ /* ignore per-frame errors */ }
    );
  }

  async function stopCamera(silent){
    if(!cameraRunning) return;
    try{ await camera.stop(); }catch(_e){}
    try{ await camera.clear(); }catch(_e){}
    cameraRunning = false;
    camStartBtn.disabled = false;
    camStopBtn.disabled = true;
    if(!silent) setStatus(scanStatus, "카메라 중지됨. Next scan 또는 스캐너 입력을 사용하세요.");
  }

  camStartBtn.addEventListener("click", ()=>startCamera());
  camStopBtn.addEventListener("click", ()=>stopCamera(false));
  camNextBtn.addEventListener("click", async ()=>{
    // "찰칵/다음" 같은 UX: 다음 스캔은 사용자가 눌러야 진행
    await startCamera();
  });

  scanCloseBtn.addEventListener("click", async ()=>{
    await stopCamera(true);
    scanDlg.close();
  });

  scanBtn.addEventListener("click", async ()=>{
    // open
    resetCtx();
    scanDlg.showModal();
    setTimeout(()=>scanInput && scanInput.focus(), 50);
  });

  // scanner input behavior
  scanInput.addEventListener("keydown", async (e)=>{
    if(e.key === "Enter"){
      e.preventDefault();
      const raw = scanInput.value;
      scanInput.value = "";
      await handleDecoded(raw, "scanner");
    }
  });

  async function getProfile(){
    const { auth, db } = window.__MAR_FB__;
    const u = auth.currentUser;
    if(!u) return null;
    const snap = await getDoc(doc(db,"users",u.uid));
    if(!snap.exists()) return null;
    const d = snap.data() || {};
    return {
      role: String(d.role||"").toLowerCase(),
      initials: String(d.initials||"").trim(),
      facilityCode: String(d.facilityCode||"").trim()
    };
  }

  function timeOk(schedHHMM){
    // +/- 60 minutes
    if(!schedHHMM) return true; // if missing, allow
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(schedHHMM).trim());
    if(!m) return true;
    const schedMin = (Number(m[1])*60 + Number(m[2]));
    const now = new Date();
    const nowMin = now.getHours()*60 + now.getMinutes();
    const diff = Math.abs(nowMin - schedMin);
    return diff <= 60;
  }

  function findPatientInState(p){
    const st = window.MAR_APP.getState();
    const name = String(p.name||"").trim();
    const found = st && st.patients && st.patients[name];
    return found ? { st, patient: found, name } : null;
  }

  function hasBatchAlready(st, patientName, batchId){
    if(!batchId) return false;
    const p = st.patients[patientName];
    if(!p || !p.meds) return false;
    const day = todayKey();
    for(const medName of Object.keys(p.meds)){
      const hist = p.meds[medName]?.history?.[day] || [];
      for(const r of hist){
        if(r && r.batchId && String(r.batchId) === String(batchId)) return true;
      }
    }
    return false;
  }

  async function recordBatch(payload, raw){
    const prof = await getProfile();
    if(!prof || !(prof.role === "admin" || prof.role === "nurse")){
      setStatus(scanStatus, "권한이 없습니다 (nurse/admin만 가능).");
      return;
    }

    const p = payload.patient || {};
    const key = patientKey(p);

    if(patientExpired()){
      setStatus(scanStatus, "환자 확인 유효시간(10분)이 만료되었습니다. 환자 QR을 다시 스캔하세요.");
      ctx.mode = "patient";
      ctx.patient = null;
      ctx.patientSetAt = 0;
      return;
    }

    if(patientKey(ctx.patient) !== key){
      setStatus(scanStatus, "환자가 다릅니다 ❌ (이름/MRN/방번호 확인)");
      // mismatch → go back to patient scan mode
      ctx.mode = "patient";
      ctx.patient = null;
      ctx.patientSetAt = 0;
      // if camera UI is available, restart camera for patient scan
      try{ await startCamera(); }catch(_e){}
      return;
    }

    const found = findPatientInState(p);
    if(!found){
      setStatus(scanStatus, "앱 상태에 해당 환자가 없습니다. (환자 이름 키 불일치)");
      return;
    }

    const { st, patient, name: patientName } = found;

    // batchId
    const batchId = getBatchId(payload, raw);

    // duplicate check (in-memory quick + persisted in history)
    const recentDup = (ctx.lastBatchId === batchId) && ((Date.now() - ctx.lastBatchAt) < 15000);
    const persistedDup = hasBatchAlready(st, patientName, batchId);

    if(recentDup || persistedDup){
      const ok = await showClickModal("이미 투약됨으로 기록된 Batch 입니다. 계속 진행할까요?");
      if(!ok){
        setStatus(scanStatus, "취소됨. 다음 Batch를 스캔하세요.");
        return;
      }
    }

    const meds = Array.isArray(payload.meds) ? payload.meds : [];
    const sched = payload.time ? String(payload.time) : nowHHMM();
    const given = nowHHMM();
    const day = todayKey();
    const initials = prof.initials || "NA";

    let recorded = 0;
    for(const medName of meds){
      if(!patient.meds || !patient.meds[medName]) continue;
      const med = patient.meds[medName];
      med.history = med.history || {};
      med.history[day] = med.history[day] || [];
      med.history[day].push({
        sched,
        given,
        initials,
        status: timeOk(payload.time) ? "ok" : "late",
        batchId
      });
      recorded++;
    }
    // saveState wrapper will bump __rev/__updatedAt

    if(window.MAR_APP.commitState){ window.MAR_APP.commitState(st, 'scan'); } else { window.MAR_APP.setState(st); }
    ctx.lastBatchId = batchId;
    ctx.lastBatchAt = Date.now();

    if(recorded === 0){
      setStatus(scanStatus, "약이 다릅니다 ❌ (환자 MAR에 없는 약 조합)");
      // keep mode=batch and allow rescan
      try{ setTimeout(()=>{ startCamera(); }, 200); }catch(_e){}
      return;
    }

    const onTime = timeOk(payload.time);
    setStatus(scanStatus, `약 스캔 완료 ✓ (${recorded}개 약 기록됨)` + (onTime ? "" : " · 시간 지연"));

    // If on-time and recorded, auto-close scan page and return to MAR
    if(onTime){
      try{ await stopCamera(true); }catch(_e){}
      try{ setTimeout(()=>{ scanDlg.close(); }, 600); }catch(_e){}
    }else{
      // late → keep scanner open for visibility
      try{ setTimeout(()=>{ startCamera(); }, 200); }catch(_e){}
    }
  }

  async function handleDecoded(raw, source){
    const payload = parsePayload(raw);
    if(!payload){
      setStatus(scanStatus, "QR 내용을 읽을 수 없습니다. (JSON 아님)");
      return;
    }

    if(payload.type === "patient"){
      const p = payload.patient || {};
      // require name+room+mrn
      if(!p.name || !p.room || !p.mrn){
        setStatus(scanStatus, "환자 QR 포맷이 올바르지 않습니다 (name/room/mrn 필요).");
        return;
      }
      ctx.patient = { name: String(p.name).trim(), room: String(p.room).trim(), mrn: String(p.mrn).trim() };
      ctx.patientSetAt = Date.now();
      ctx.mode = "batch";
      setStatus(scanStatus, `환자 스캔 완료 ✓ ${ctx.patient.name} / ${ctx.patient.room} / ${ctx.patient.mrn}  (10분 유효)`);
      // patient ok → auto switch to batch scan (camera)
      try{ setTimeout(()=>{ startCamera(); }, 200); }catch(_e){}
      return;
    }

    if(payload.type === "batch"){
      // verify patient fields exist
      const p = payload.patient || {};
      if(!p.name || !p.room || !p.mrn){
        setStatus(scanStatus, "Batch QR에 patient(name/room/mrn)이 없습니다.");
        return;
      }
      await recordBatch(payload, raw);
      return;
    }

    setStatus(scanStatus, `알 수 없는 QR type: ${payload.type}`);
  }
}

// Kick scan init once globals ready
(async ()=>{
  try{
    await waitForGlobals();
    await initScanUI();
  }catch(e){
    console.warn("SCAN init failed:", e);
  }
})();
