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
  return JSON.stringify(payload);
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
  const w = window.open("", "_blank", "noopener,noreferrer,width=1100,height=780");
  if(!w) return null;
  w.document.open();
  w.document.write(popupHtmlShell());
  w.document.close();
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
      const anyChecked = !!rightBody.querySelector('input[type="checkbox"][data-export="1"]:checked');
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
