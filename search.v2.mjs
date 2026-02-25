// search.v2.mjs
// ✅ 기존 scan.v2.mjs/scanDlg를 건드리지 않는 "환자 검색 전용" 스캔 창

const searchBtn = document.getElementById("searchBtn");

let dlg = null;
let stream = null;
let rafId = null;

function safeParseQR(raw) {
  if (raw == null) return null;
  let t = String(raw);

  // 컨트롤 문자 제거(스캐너가 이상한 문자를 섞는 경우 대비)
  t = t.replace(/[\u0000-\u001F\u007F]/g, "").trim();

  // JSON 아닌 경우는 그냥 문자열로 둠
  try {
    return JSON.parse(t);
  } catch {
    return { _raw: t };
  }
}

function findAndSelectPatientByName(name) {
  name = (name || "").trim();
  if (!name) return false;

  // 환자 리스트 버튼을 찾아서 "자동 클릭" (app.v2.mjs 내부 선택 로직 그대로 타게 함)
  const list = document.getElementById("patientList");
  if (!list) return false;

  const buttons = Array.from(list.querySelectorAll("button.item"));
  // 버튼 textContent는 "이름\n룸 | MRN ..." 형태라서, 시작이 이름인 걸 우선 매칭
  let target = buttons.find(b => (b.textContent || "").trim().startsWith(name));
  if (!target) {
    // 혹시 이름이 중간에 포함되는 경우도 대비
    target = buttons.find(b => (b.textContent || "").includes(name));
  }
  if (!target) return false;

  target.click();
  return true;
}

function handlePatientPayload(payload) {
  const obj = safeParseQR(payload);

  // 우리가 기대하는 환자 QR 형태:
  // { v:1, type:"patient", facility:"...", patient:{ name:"...", room:"...", mrn:"..." } }
  let patientName = null;

  if (obj && obj.type === "patient" && obj.patient && obj.patient.name) {
    patientName = obj.patient.name;
  } else if (obj && obj.patient && obj.patient.name) {
    // 타입이 누락돼도 name이 있으면 시도
    patientName = obj.patient.name;
  }

  if (!patientName) {
    alert("환자 QR이 아닙니다.");
    return;
  }

  const ok = findAndSelectPatientByName(patientName);
  if (!ok) {
    alert(`환자 목록에서 찾지 못했습니다: ${patientName}`);
    return;
  }

  closeSearch();
}

function ensureDialog() {
  if (dlg) return;

  dlg = document.createElement("dialog");
  dlg.id = "searchDlg";
  dlg.innerHTML = `
    <div class="dlg-head">🔍 환자 검색</div>
    <div class="dlg-body">
      <div class="hint" id="searchStatus">환자 QR을 스캔하세요. (스캐너/카메라)</div>

      <div style="display:flex; gap:10px; align-items:flex-start; flex-wrap:wrap;">
        <div style="flex:1; min-width:260px;">
          <div style="font-weight:700; margin-bottom:6px;">Camera (backup)</div>
          <video id="searchVideo" style="width:320px; max-width:100%; background:#111; border-radius:12px;"></video>
          <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
            <button class="btn secondary" id="searchCamStart">Start camera</button>
            <button class="btn secondary" id="searchCamStop" disabled>Stop</button>
          </div>
          <div class="hint" style="margin-top:6px;">※ iPhone/Safari는 카메라 QR이 제한될 수 있어요.</div>
        </div>

        <div style="flex:1; min-width:240px;">
          <div style="font-weight:700; margin-bottom:6px;">Scanner (Bluetooth/USB)</div>
          <div class="hint">스캐너는 키보드처럼 입력됩니다. 아래 입력칸에 포커스 두고 찍으세요.</div>
          <input id="searchInput" placeholder="Scan patient QR here…" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <div class="hint" style="margin-top:6px;">스캔되면 자동으로 해당 환자 MAR로 이동합니다.</div>
        </div>
      </div>
    </div>
    <div class="dlg-actions">
      <button class="btn secondary" id="searchClose">Close</button>
    </div>
  `;

  document.body.appendChild(dlg);

  const closeBtn = dlg.querySelector("#searchClose");
  closeBtn.addEventListener("click", closeSearch);

  // 스캐너 입력
  const input = dlg.querySelector("#searchInput");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = input.value;
      input.value = "";
      handlePatientPayload(v);
    }
  });

  // 카메라 버튼
  dlg.querySelector("#searchCamStart").addEventListener("click", startCamera);
  dlg.querySelector("#searchCamStop").addEventListener("click", stopCamera);

  // dialog 닫힐 때 카메라 정리
  dlg.addEventListener("close", () => {
    stopCamera();
  });
}

function openSearch() {
  ensureDialog();
  dlg.showModal();

  // 입력칸 포커스
  const input = dlg.querySelector("#searchInput");
  setTimeout(() => input && input.focus(), 50);
}

function closeSearch() {
  if (!dlg) return;
  try { dlg.close(); } catch {}
  // stopCamera는 close 이벤트에서도 호출되지만 안전하게 한 번 더
  stopCamera();
}

async function startCamera() {
  if (!dlg) return;

  const statusEl = dlg.querySelector("#searchStatus");
  const video = dlg.querySelector("#searchVideo");
  const startBtn = dlg.querySelector("#searchCamStart");
  const stopBtn = dlg.querySelector("#searchCamStop");

  // BarcodeDetector 지원 체크
  if (!("BarcodeDetector" in window)) {
    statusEl.textContent = "이 브라우저는 카메라 QR 스캔(BarcodeDetector)을 지원하지 않습니다. 스캐너 입력을 사용하세요.";
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    await video.play();

    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusEl.textContent = "카메라로 환자 QR을 비추세요…";

    const detector = new BarcodeDetector({ formats: ["qr_code"] });

    const loop = async () => {
      if (!dlg || dlg.open === false) return;
      if (!video || video.readyState < 2) {
        rafId = requestAnimationFrame(loop);
        return;
      }
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length) {
          const raw = codes[0].rawValue;
          handlePatientPayload(raw);
          return;
        }
      } catch {
        // ignore detect errors and continue
      }
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
  } catch (err) {
    statusEl.textContent = "카메라 권한/장치 오류. 스캐너 입력을 사용하세요.";
    stopCamera();
  }
}

function stopCamera() {
  const startBtn = dlg?.querySelector("#searchCamStart");
  const stopBtn = dlg?.querySelector("#searchCamStop");

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  if (startBtn) startBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;

  const video = dlg?.querySelector("#searchVideo");
  if (video) {
    video.pause?.();
    video.srcObject = null;
  }
}

if (searchBtn) {
  searchBtn.addEventListener("click", openSearch);
}
