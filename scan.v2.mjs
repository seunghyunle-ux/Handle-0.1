/* scan.v2.mjs
   - SAFE additive scanner module
   - DOES NOT touch QR/SCAN disable logic
   - Uses window.MAR_APP.recordDoseGiven() (added in app.v2.mjs)
*/

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function sanitizeText(t){
  // control chars 제거 + trim
  return String(t || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

function tryParseJson(text){
  const t = sanitizeText(text);
  if(!t) return null;
  if(!(t.startsWith("{") && t.endsWith("}"))) return null;
  try{ return JSON.parse(t); }catch(_e){ return null; }
}

function isPatientPayload(p){
  if(!p || typeof p !== "object") return false;
  // patient wristband payload: type:"patient" or meds 없음 + patient object 있음
  if(p.type === "patient") return !!p.patient;
  if(p.patient && !p.meds) return true;
  return false;
}

function isBatchPayload(p){
  if(!p || typeof p !== "object") return false;
  return !!(p.patient && Array.isArray(p.meds) && p.time);
}

function el(tag, props){
  const x = document.createElement(tag);
  if(props){
    for(const k of Object.keys(props)){
      if(k === "style") Object.assign(x.style, props.style);
      else if(k === "className") x.className = props.className;
      else if(k === "text") x.textContent = props.text;
      else x[k] = props[k];
    }
  }
  return x;
}

async function waitForApp(){
  let tries = 0;
  while(true){
    if(window.MAR_APP && typeof window.MAR_APP.recordDoseGiven === "function") return;
    tries++;
    if(tries % 20 === 0) console.warn("SCAN: waiting for MAR_APP hooks...");
    await sleep(100);
  }
}

function buildScanDialog(){
  const dlg = el("dialog", { });
  dlg.style.width = "min(720px, 96vw)";
  dlg.style.border = "1px solid #2a2a35";
  dlg.style.borderRadius = "14px";
  dlg.style.padding = "0";
  dlg.style.background = "#13131a";
  dlg.style.color = "#f2f2f7";

  const head = el("div", { });
  head.style.display = "flex";
  head.style.alignItems = "center";
  head.style.justifyContent = "space-between";
  head.style.padding = "12px 12px";
  head.style.borderBottom = "1px solid #2a2a35";

  const title = el("div", { text:"📷 Scan (Patient → Batch)" });
  title.style.fontWeight = "900";

  const closeBtn = el("button", { text:"Close" });
  closeBtn.className = "btn secondary";
  closeBtn.style.cursor = "pointer";
  closeBtn.onclick = ()=> dlg.close();

  head.appendChild(title);
  head.appendChild(closeBtn);

  const body = el("div", {});
  body.style.padding = "12px";
  body.style.display = "grid";
  body.style.gap = "10px";

  const status = el("div", { text:"Ready. Scan patient first." });
  status.style.fontSize = "13px";
  status.style.color = "#a1a1aa";

  const videoWrap = el("div", {});
  videoWrap.style.background = "#0b0b0f";
  videoWrap.style.border = "1px solid #2a2a35";
  videoWrap.style.borderRadius = "12px";
  videoWrap.style.overflow = "hidden";

  const video = el("video", { });
  video.setAttribute("playsinline", "");
  video.autoplay = true;
  video.muted = true;
  video.style.width = "100%";
  video.style.height = "340px";
  video.style.objectFit = "cover";
  videoWrap.appendChild(video);

  const row = el("div", {});
  row.style.display = "flex";
  row.style.gap = "8px";
  row.style.flexWrap = "wrap";

  const snapBtn = el("button", { text:"Scan now" });
  snapBtn.className = "btn";
  snapBtn.style.cursor = "pointer";

  const pasteBtn = el("button", { text:"Paste payload" });
  pasteBtn.className = "btn secondary";
  pasteBtn.style.cursor = "pointer";

  row.appendChild(snapBtn);
  row.appendChild(pasteBtn);

  const textarea = el("textarea", {});
  textarea.placeholder = "If camera scan fails, paste the QR payload JSON here…";
  textarea.style.display = "none";
  textarea.style.width = "100%";
  textarea.style.minHeight = "120px";
  textarea.style.padding = "10px";
  textarea.style.borderRadius = "12px";
  textarea.style.border = "1px solid #2a2a35";
  textarea.style.background = "#0b0b0f";
  textarea.style.color = "#f2f2f7";

  const applyPasteBtn = el("button", { text:"Apply pasted payload" });
  applyPasteBtn.className = "btn";
  applyPasteBtn.style.cursor = "pointer";
  applyPasteBtn.style.display = "none";

  const info = el("div", { text:"Tip: If initials are unset, set them first (top pill shows initials)." });
  info.style.fontSize = "12px";
  info.style.color = "#a1a1aa";

  body.appendChild(status);
  body.appendChild(videoWrap);
  body.appendChild(row);
  body.appendChild(textarea);
  body.appendChild(applyPasteBtn);
  body.appendChild(info);

  dlg.appendChild(head);
  dlg.appendChild(body);

  document.body.appendChild(dlg);

  return { dlg, video, status, snapBtn, pasteBtn, textarea, applyPasteBtn };
}

async function startCamera(video){
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false
  });
  video.srcObject = stream;
  return stream;
}

function stopCamera(stream){
  try{
    if(stream){
      stream.getTracks().forEach(t=>{ try{ t.stop(); }catch(_e){} });
    }
  }catch(_e){}
}

function getBarcodeDetector(){
  // Chrome/Edge/Android OK. iOS Safari는 버전에 따라 미지원일 수 있음.
  if("BarcodeDetector" in window){
    try{
      return new window.BarcodeDetector({ formats: ["qr_code"] });
    }catch(_e){
      return null;
    }
  }
  return null;
}

async function scanOnce(detector, video){
  if(!detector) return null;
  try{
    const codes = await detector.detect(video);
    if(!codes || codes.length===0) return null;
    // 가장 첫번째 코드 사용
    return codes[0].rawValue || null;
  }catch(_e){
    return null;
  }
}

(async function main(){
  await waitForApp();

  const scanBtn = document.getElementById("scanBtn");
  if(!scanBtn){
    console.warn("SCAN: #scanBtn not found; module idle.");
    return;
  }

  let ui = null;
  let camStream = null;
  let detector = null;

  // session state
  let scannedPatient = null; // {name, room, mrn, facility}
  let scannedBatch = null;

  async function handlePayload(obj){
    if(!obj){
      ui.status.textContent = "❌ Not a valid QR JSON payload.";
      ui.status.style.color = "#ff453a";
      return;
    }

    const appFacility = window.MAR_APP.getFacilityCode ? window.MAR_APP.getFacilityCode() : null;

    if(isPatientPayload(obj)){
      const p = obj.patient || {};
      const name = sanitizeText(p.name);
      const room = sanitizeText(p.room);
      const mrn  = sanitizeText(p.mrn);
      const fac  = sanitizeText(obj.facility || "");
      scannedPatient = { name, room, mrn, facility: fac || null };

      // facility mismatch warning only (non-blocking)
      if(appFacility && fac && appFacility !== fac.toUpperCase()){
        ui.status.textContent = `⚠ Patient 확인됨: ${name} (facility mismatch: app=${appFacility}, qr=${fac})`;
        ui.status.style.color = "#ffd60a";
      }else{
        ui.status.textContent = `✅ 환자 확인됨: ${name}${room ? " · "+room : ""}${mrn ? " · "+mrn : ""}`;
        ui.status.style.color = "#32d74b";
      }
      return;
    }

    if(isBatchPayload(obj)){
      scannedBatch = obj;

      if(!scannedPatient || !scannedPatient.name){
        ui.status.textContent = "⚠ Batch는 확인됐지만, 먼저 환자 QR을 스캔해야 기록할 수 있어요.";
        ui.status.style.color = "#ffd60a";
        return;
      }

      const batchPatientName = sanitizeText(obj.patient && obj.patient.name);
      const time = sanitizeText(obj.time);
      const meds = Array.isArray(obj.meds) ? obj.meds.map(sanitizeText).filter(Boolean) : [];

      if(batchPatientName && batchPatientName !== scannedPatient.name){
        ui.status.textContent = `⚠ Batch 환자(${batchPatientName})와 스캔된 환자(${scannedPatient.name})가 달라요. 기록 중단.`;
        ui.status.style.color = "#ff453a";
        return;
      }

      if(!window.MAR_APP.getCurrentInitials || !window.MAR_APP.getCurrentInitials()){
        ui.status.textContent = "⚠ Initials가 설정되어야 기록이 됩니다. Initials 입력창을 열게요.";
        ui.status.style.color = "#ffd60a";
        if(window.MAR_APP.promptInitials) window.MAR_APP.promptInitials();
        return;
      }

      let okCount = 0;
      let fail = [];

      for(const med of meds){
        const r = window.MAR_APP.recordDoseGiven(scannedPatient.name, med, time, { silent:true });
        if(r && r.ok){
          okCount++;
        }else{
          fail.push({ med, reason: (r && r.reason) ? r.reason : "UNKNOWN" });
        }
      }

      if(okCount > 0 && fail.length === 0){
        ui.status.textContent = `✅ batch 확인됨 · ${okCount}개 약 기록됨 (Given)`;
        ui.status.style.color = "#32d74b";
      }else if(okCount > 0){
        const failTxt = fail.slice(0,3).map(x=>`${x.med}(${x.reason})`).join(", ");
        ui.status.textContent = `✅ ${okCount}개 기록됨 · 일부 실패: ${failTxt}${fail.length>3 ? " ..." : ""}`;
        ui.status.style.color = "#ffd60a";
      }else{
        const failTxt = fail.slice(0,4).map(x=>`${x.med}(${x.reason})`).join(", ");
        ui.status.textContent = `❌ 기록 실패: ${failTxt || "unknown"}`;
        ui.status.style.color = "#ff453a";
      }

      return;
    }

    ui.status.textContent = "⚠ Unknown payload shape (not patient, not batch).";
    ui.status.style.color = "#ffd60a";
  }

  async function openScan(){
    if(!ui){
      ui = buildScanDialog();

      ui.pasteBtn.onclick = ()=>{
        const on = ui.textarea.style.display === "none";
        ui.textarea.style.display = on ? "" : "none";
        ui.applyPasteBtn.style.display = on ? "" : "none";
      };

      ui.applyPasteBtn.onclick = async ()=>{
        const obj = tryParseJson(ui.textarea.value);
        await handlePayload(obj);
      };

      ui.snapBtn.onclick = async ()=>{
        // Manual “scan now”: attempt detector once (useful for iOS weirdness)
        const raw = await scanOnce(detector, ui.video);
        if(raw){
          const obj = tryParseJson(raw);
          await handlePayload(obj);
        }else{
          ui.status.textContent = "…No QR detected. Move closer / adjust focus, or use Paste payload.";
          ui.status.style.color = "#a1a1aa";
        }
      };

      ui.dlg.addEventListener("close", ()=>{
        stopCamera(camStream);
        camStream = null;
      });
    }

    ui.dlg.showModal();

    try{
      camStream = await startCamera(ui.video);
      detector = getBarcodeDetector();

      if(!detector){
        ui.status.textContent = "⚠ This browser doesn't support live QR detect. Use 'Paste payload' fallback.";
        ui.status.style.color = "#ffd60a";
        return;
      }

      ui.status.textContent = "Ready. Scan patient first.";
      ui.status.style.color = "#a1a1aa";

      // background loop while dialog open
      (async ()=>{
        while(ui && ui.dlg.open){
          const raw = await scanOnce(detector, ui.video);
          if(raw){
            const obj = tryParseJson(raw);
            if(obj) await handlePayload(obj);
            // 너무 연속으로 찍히는 것 방지
            await sleep(800);
          }else{
            await sleep(150);
          }
        }
      })();

    }catch(e){
      console.error("SCAN camera error:", e);
      ui.status.textContent = "❌ Camera permission/launch failed. Use 'Paste payload' fallback.";
      ui.status.style.color = "#ff453a";
    }
  }

  // 안전: disable/enable은 절대 안 건드리고, 클릭만 연결
  scanBtn.addEventListener("click", (ev)=>{
    try{
      // disabled면 브라우저가 클릭을 막는 경우가 많지만,
      // 혹시 들어오면 그냥 return (상태 변경 X)
      if(scanBtn.disabled) return;
      openScan();
    }catch(_e){}
  }, { passive:true });

})();
