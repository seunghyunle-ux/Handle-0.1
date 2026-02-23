/* app.v2.mjs - Mini MAR local + Firebase Auth init (no sync yet) */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-analytics.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";

/* ===========================
   Firebase init
=========================== */
const firebaseConfig = {
  apiKey: "AIzaSyAo6SXsvtUurqDJaH1EUxqMOqCvHV-GHDo",
  authDomain: "handle-5a293.firebaseapp.com",
  projectId: "handle-5a293",
  storageBucket: "handle-5a293.firebasestorage.app",
  messagingSenderId: "784177638758",
  appId: "1:784177638758:web:8f1c219333bcf23868aca7",
  measurementId: "G-9EY3N4JKCB"
};

const fbStatus = document.getElementById("fbStatus");
const whoPill = document.getElementById("whoPill");

let app = null, auth = null, db = null;

try {
  app = initializeApp(firebaseConfig);
  try { getAnalytics(app); } catch(_e) {}
  auth = getAuth(app);
  db = getFirestore(app);
  fbStatus.textContent = "Firebase: ready";
} catch (e) {
  console.error(e);
  fbStatus.textContent = "Firebase: init error";
}

/* ===========================
   Utilities
=========================== */
function pad2(n){ return String(n).padStart(2, "0"); }
function ymd(d){ return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }

function parseISODate(s){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if(!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0,0,0,0);
}
function dtForDay(dayDate, hhmm){
  const [h,m] = hhmm.split(":").map(Number);
  return new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), h, m, 0, 0);
}
function minutesDiff(a,b){
  return Math.abs((a.getTime()-b.getTime())/60000);
}
function parseTimesCSV(s){
  if(!s) return [];
  const parts = s.split(",").map(x=>x.trim()).filter(Boolean);
  const ok = [];
  for(const p of parts){
    if(/^\d{2}:\d{2}$/.test(p)){
      const [h,m]=p.split(":").map(Number);
      if(h>=0 && h<=23 && m>=0 && m<=59) ok.push(p);
    }
  }
  ok.sort();
  return [...new Set(ok)];
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

/* ===========================
   HARD DELETE helpers (patient + med)
   - 환자 퇴원 = patient 완전 삭제
   - 약 중단 = med 완전 삭제
=========================== */
function deletePatientByName(name){
  if(!name) return;
  if(!state.patients || !state.patients[name]) return;

  // 완전 삭제
  delete state.patients[name];

  // 선택 환자 정리
  if(selectedPatient === name){
    const names = Object.keys(state.patients).sort((a,b)=>a.localeCompare(b));
    selectedPatient = names.length ? names[0] : null;
  }

  saveState();
  renderAll();
}

function deleteMedFromSelectedPatient(medNameKey){
  if(!selectedPatient) return;
  const p = ensurePatient(selectedPatient);
  if(!p.meds || !p.meds[medNameKey]) return;

  // 완전 삭제 (해당 med의 history도 같이 날아감)
  delete p.meds[medNameKey];

  saveState();
  renderAll();
}

/* ===========================
   DOM refs
=========================== */
const loginOverlay = document.getElementById("loginOverlay");
const appRoot = document.getElementById("appRoot");

const facilityInput = document.getElementById("facilityInput");
const nurseInput = document.getElementById("nurseInput");
const passInput = document.getElementById("passInput");
const loginBtn = document.getElementById("loginBtn");
const demoBtn = document.getElementById("demoBtn");
const loginErr = document.getElementById("loginErr");
const logoutBtn = document.getElementById("logoutBtn");

const patientListEl = document.getElementById("patientList");
const rightTitleEl = document.getElementById("rightTitle");
const rightSubEl = document.getElementById("rightSub");
const gridWrapEl = document.getElementById("gridWrap");
const todayPillEl = document.getElementById("todayPill");
const addMedBtn = document.getElementById("addMedBtn");
const printBtn = document.getElementById("printBtn");
const datePicker = document.getElementById("datePicker");

const patientDlg = document.getElementById("patientDlg");
const patientName = document.getElementById("patientName");
const patientRoom = document.getElementById("patientRoom");
const patientMRN = document.getElementById("patientMRN");
const patientSave = document.getElementById("patientSave");
const patientCancel = document.getElementById("patientCancel");

const medDlg = document.getElementById("medDlg");
const medName = document.getElementById("medName");
const medTimes = document.getElementById("medTimes");
const medSave = document.getElementById("medSave");
const medCancel = document.getElementById("medCancel");
const weeklyBox = document.getElementById("weeklyBox");
const intervalBox = document.getElementById("intervalBox");
const weekdayChips = document.getElementById("weekdayChips");
const intervalN = document.getElementById("intervalN");
const intervalStart = document.getElementById("intervalStart");

const warnDlg = document.getElementById("warnDlg");
const warnClose = document.getElementById("warnClose");
const warnDetail = document.getElementById("warnDetail");

const initialsDlg = document.getElementById("initialsDlg");
const initialsInput = document.getElementById("initialsInput");
const initialsSaveBtn = document.getElementById("initialsSave");
const initialsLaterBtn = document.getElementById("initialsLater");

/* ===========================
   Auth helpers
=========================== */
function makeEmail(facilityCode, nurseId){
  return `${nurseId}@${facilityCode}.local`.toLowerCase();
}

let currentEmail = null;
let currentInitials = null;

function initialsKey(email){
  return "mini_mar_initials_" + String(email || "demo").toLowerCase();
}
function loadInitials(email){
  const v = localStorage.getItem(initialsKey(email));
  return v && v.trim() ? v.trim().toUpperCase() : null;
}
function saveInitials(email, initials){
  localStorage.setItem(initialsKey(email), String(initials).trim().toUpperCase());
}

function setWhoPill(){
  const who = currentEmail ? ("Signed in: " + currentEmail) : "Demo mode (no sync)";
  const ini = currentInitials ? (" · Initials: " + currentInitials) : " · Initials: (unset)";
  whoPill.textContent = who + ini;
}

/* ===========================
   Local data model
=========================== */
const KEY = "mini_mar_local_v3";
function loadState(){
  try{
    const raw = localStorage.getItem(KEY);
    if(!raw) return {patients:{}};
    const s = JSON.parse(raw);
    if(!s || !s.patients) return {patients:{}};
    return s;
  }catch(_e){
    return {patients:{}};
  }
}
function saveState(){
  localStorage.setItem(KEY, JSON.stringify(state));
}

const WEEKDAYS = [
  {k:1, label:"월"},
  {k:2, label:"화"},
  {k:3, label:"수"},
  {k:4, label:"목"},
  {k:5, label:"금"},
  {k:6, label:"토"},
  {k:0, label:"일"},
];

function daysBetween(a,b){
  return Math.floor((a.getTime()-b.getTime())/(24*60*60*1000));
}
function isMedActiveOnDate(medObj, date){
  const sch = (medObj && medObj.schedule) ? medObj.schedule : {type:"weekly", days:[0,1,2,3,4,5,6]};
  if(sch.type === "weekly"){
    const day = date.getDay();
    return Array.isArray(sch.days) && sch.days.includes(day);
  }
  if(sch.type === "interval"){
    const every = Number(sch.every);
    const start = parseISODate(sch.start);
    if(!every || !start) return false;
    const d0 = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0,0,0,0);
    const diff = daysBetween(d0, start);
    if(diff < 0) return false;
    return (diff % every) === 0;
  }
  return true;
}

let state = loadState();
let selectedPatient = null;
let currentDay = new Date();
currentDay.setHours(0,0,0,0);

/* ===========================
   Render
=========================== */
function ensurePatient(name){
  if(!state.patients[name]) state.patients[name] = { meds:{}, room:"", mrn:"" };
  if(!state.patients[name].meds) state.patients[name].meds = {};
  if(state.patients[name].room === undefined) state.patients[name].room = "";
  if(state.patients[name].mrn === undefined) state.patients[name].mrn = "";
  return state.patients[name];
}

function renderPatients(){
  const names = Object.keys(state.patients).sort((a,b)=>a.localeCompare(b));
  patientListEl.innerHTML = "";
  if(names.length===0){
    patientListEl.innerHTML = `<div class="empty">No patients. Tap +</div>`;
    return;
  }

  for(const name of names){
    const btn = document.createElement("button");
    btn.className = "item" + (selectedPatient===name ? " active":"");

    const meds = Object.keys(state.patients[name].meds || {});
    // 기존: btn.innerHTML 문자열 -> 변경: DOM으로 구성 (data-attribute 깨짐/인젝션 방지)
    btn.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.justifyContent = "space-between";
    wrap.style.gap = "8px";
    wrap.style.width = "100%";

    const left = document.createElement("div");
    left.style.minWidth = "0";

    const title = document.createElement("div");
    title.style.whiteSpace = "nowrap";
    title.style.overflow = "hidden";
    title.style.textOverflow = "ellipsis";
    title.textContent = name;

    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `${meds.length} meds`;

    left.appendChild(title);
    left.appendChild(sub);

    const del = document.createElement("button");
    del.type = "button";
    del.title = "Delete patient";
    del.textContent = "🗑️";
    del.style.background = "none";
    del.style.border = "none";
    del.style.cursor = "pointer";
    del.style.fontSize = "14px";
    del.style.flex = "0 0 auto";

    // 중요: 삭제 버튼 누를 때 환자 선택(btn.onclick) 안 타게 막기
    del.onclick = (ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      const ok1 = confirm(`환자 "${name}"를 완전 삭제할까요? 되돌릴 수 없습니다.`);
      if(!ok1) return;
      const ok2 = confirm("정말 삭제합니다. 계속할까요?");
      if(!ok2) return;
      deletePatientByName(name);
    };

    wrap.appendChild(left);
    wrap.appendChild(del);

    btn.appendChild(wrap);
    btn.onclick = ()=>{ selectedPatient = name; renderAll(); };
    patientListEl.appendChild(btn);
  }
}

function renderHeader(){
  todayPillEl.textContent = "Day: " + ymd(currentDay);
  datePicker.value = ymd(currentDay);

  if(!selectedPatient){
    rightTitleEl.textContent = "Select patient";
    rightSubEl.textContent = "";
    addMedBtn.disabled = true;
    printBtn.disabled = true;
  }else{
    rightTitleEl.textContent = selectedPatient;
    const medsCount = Object.keys(state.patients[selectedPatient].meds||{}).length;
    rightSubEl.textContent = `${medsCount} meds · Tap dose to record`;
    addMedBtn.disabled = false;
    printBtn.disabled = false;
  }
  setWhoPill();
}

function renderGrid(){
  if(!selectedPatient){
    gridWrapEl.innerHTML = `<div class="empty">Select a patient to view MAR.</div>`;
    return;
  }

  const patient = ensurePatient(selectedPatient);
  const meds = patient.meds || {};
  const medNames = Object.keys(meds).sort((a,b)=>a.localeCompare(b));
  const activeMeds = medNames.filter(m=>isMedActiveOnDate(meds[m], currentDay));

  if(activeMeds.length===0){
    gridWrapEl.innerHTML = `<div class="empty">No scheduled meds for this day.</div>`;
    return;
  }

  const grid = document.createElement("div");
  grid.className = "grid";

  const h0 = document.createElement("div");
  h0.className = "cell head left";
  h0.textContent = "Medication";
  grid.appendChild(h0);

  for(let hr=0; hr<24; hr++){
    const hc = document.createElement("div");
    hc.className = "cell head";
    hc.textContent = pad2(hr)+":00";
    grid.appendChild(hc);
  }

  const dayKey = ymd(currentDay);

  for(const med of activeMeds){
    const lc = document.createElement("div");
    lc.className = "cell leftcol";

    const sch = meds[med].schedule || {type:"weekly", days:[0,1,2,3,4,5,6]};
    let schText = "";
    if(sch.type === "weekly"){
      const labels = WEEKDAYS.filter(w=>sch.days.includes(w.k)).map(w=>w.label).join("");
      schText = "요일: " + (labels || "(none)");
    }else{
      schText = `${sch.every}일마다 · 시작 ${sch.start || "-"}`;
    }

    // 기존: lc.innerHTML 문자열 -> 변경: DOM으로 구성 (삭제 버튼 안전)
    lc.innerHTML = "";
    const col = document.createElement("div");
    col.style.display = "flex";
    col.style.flexDirection = "column";
    col.style.gap = "6px";

    const topRow = document.createElement("div");
    topRow.style.display = "flex";
    topRow.style.alignItems = "center";
    topRow.style.justifyContent = "space-between";
    topRow.style.gap = "8px";

    const medTitle = document.createElement("div");
    medTitle.style.fontWeight = "700";
    medTitle.style.minWidth = "0";
    medTitle.style.whiteSpace = "nowrap";
    medTitle.style.overflow = "hidden";
    medTitle.style.textOverflow = "ellipsis";
    medTitle.textContent = med;

    const delMedBtn = document.createElement("button");
    delMedBtn.type = "button";
    delMedBtn.title = "Remove medication";
    delMedBtn.textContent = "🗑️";
    delMedBtn.style.background = "none";
    delMedBtn.style.border = "none";
    delMedBtn.style.cursor = "pointer";
    delMedBtn.style.fontSize = "14px";
    delMedBtn.style.flex = "0 0 auto";

    delMedBtn.onclick = (ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      const ok = confirm(`"${med}" 약을 완전 삭제할까요? (이 약의 기록도 함께 삭제됩니다)`);
      if(!ok) return;
      deleteMedFromSelectedPatient(med);
    };

    topRow.appendChild(medTitle);
    topRow.appendChild(delMedBtn);

    const timesLine = document.createElement("div");
    timesLine.className = "muted";
    timesLine.style.fontSize = "11px";
    timesLine.textContent = (meds[med].times||[]).join(", ");

    const schLine = document.createElement("div");
    schLine.className = "muted";
    schLine.style.fontSize = "11px";
    schLine.textContent = schText;

    col.appendChild(topRow);
    col.appendChild(timesLine);
    col.appendChild(schLine);

    lc.appendChild(col);
    grid.appendChild(lc);

    const hist = (meds[med].history && meds[med].history[dayKey]) ? meds[med].history[dayKey] : [];
    const bySched = {};
    for(const r of hist){ if(r && r.sched) bySched[r.sched] = r; }

    for(let hr=0; hr<24; hr++){
      const c = document.createElement("div");
      c.className = "cell";
      c.style.justifyContent = "flex-start";
      c.style.alignItems = "flex-start";

      const times = (meds[med].times||[]).filter(t=>Number(t.slice(0,2))===hr);
      if(times.length===0){
        c.textContent = "";
      }else{
        c.style.flexDirection = "column";
        c.style.gap = "6px";
        c.style.padding = "8px";
        c.style.color = "var(--text)";

        for(const t of times){
          const rec = bySched[t];
          const block = document.createElement("div");
          block.className = "dose";
          if(rec && rec.status==="ok") block.classList.add("done");
          if(rec && rec.status==="late") block.classList.add("late");

          const givenText = rec ? (`Given: ${rec.given} ${rec.initials||""}`.trim()) : "Tap to Give";
          block.innerHTML = `<div><b>${escapeHtml(t)}</b></div><div class="small">${escapeHtml(givenText)}</div>`;
          block.onclick = ()=> toggleDose(med, t);
          c.appendChild(block);
        }
      }
      grid.appendChild(c);
    }
  }

  gridWrapEl.innerHTML = "";
  gridWrapEl.appendChild(grid);
}

function renderAll(){
  renderPatients();
  renderHeader();
  renderGrid();
}

/* ===========================
   Dialogs & actions
=========================== */
function openInitialsDialog(){
  initialsInput.value = currentInitials || "";
  initialsDlg.showModal();
  initialsInput.focus();
}

initialsSaveBtn.onclick = ()=>{
  const v = (initialsInput.value||"").trim().toUpperCase();
  if(!v) return;
  if(!/^[A-Z0-9]{2,6}$/.test(v)) return;
  const keyEmail = currentEmail || "demo";
  saveInitials(keyEmail, v);
  currentInitials = v;
  initialsDlg.close();
  renderAll();
};
initialsLaterBtn.onclick = ()=>initialsDlg.close();

whoPill.style.cursor = "pointer";
whoPill.title = "Click to set initials";
whoPill.onclick = ()=> openInitialsDialog();

function addPatient(){
  patientName.value = "";
  patientRoom.value = "";
  patientMRN.value = "";
  patientDlg.showModal();
  patientName.focus();
}
patientSave.onclick = ()=>{
  const name = patientName.value.trim();
  const room = (patientRoom.value || "").trim();
  const mrn  = (patientMRN.value || "").trim();

  if(!name) return;

  const p = ensurePatient(name);
  p.room = room;
  p.mrn = mrn;

  saveState();
  selectedPatient = name;
  patientDlg.close();
  renderAll();
};
patientCancel.onclick = ()=>patientDlg.close();
document.getElementById("addPatientBtn").onclick = addPatient;

function buildWeekdayChips(){
  weekdayChips.innerHTML = "";
  for(const w of WEEKDAYS){
    const chip = document.createElement("label");
    chip.className = "daychip";
    chip.innerHTML = `<input type="checkbox" data-day="${w.k}" checked /> ${w.label}`;
    weekdayChips.appendChild(chip);
  }
}
function getSelectedSchedType(){
  const r = document.querySelector('input[name="schedType"]:checked');
  return r ? r.value : "weekly";
}
function updateScheduleUI(){
  const t = getSelectedSchedType();
  weeklyBox.style.display = (t==="weekly") ? "" : "none";
  intervalBox.style.display = (t==="interval") ? "" : "none";
}
document.querySelectorAll('input[name="schedType"]').forEach(r=>{
  r.addEventListener("change", updateScheduleUI);
});

function addMed(){
  if(!selectedPatient) return;
  medName.value = "";
  medTimes.value = "";
  buildWeekdayChips();
  intervalN.value = "";
  intervalStart.value = ymd(currentDay);
  document.querySelector('input[name="schedType"][value="weekly"]').checked = true;
  updateScheduleUI();
  medDlg.showModal();
  medName.focus();
}
addMedBtn.onclick = addMed;
medCancel.onclick = ()=>medDlg.close();

function readWeeklyDays(){
  const checks = weekdayChips.querySelectorAll('input[type="checkbox"]');
  const out = [];
  checks.forEach(c=>{ if(c.checked) out.push(Number(c.dataset.day)); });
  return out;
}

medSave.onclick = ()=>{
  const m = medName.value.trim();
  const times = parseTimesCSV(medTimes.value.trim());
  if(!m || times.length===0) return;

  const p = ensurePatient(selectedPatient);
  if(!p.meds[m]) p.meds[m] = { times:[], history:{}, schedule:null };
  p.meds[m].times = times;
  p.meds[m].history = p.meds[m].history || {};

  const schedType = getSelectedSchedType();
  if(schedType === "weekly"){
    const days = readWeeklyDays();
    if(days.length === 0) return;
    p.meds[m].schedule = { type:"weekly", days };
  }else{
    const every = Number((intervalN.value||"").trim());
    const start = intervalStart.value;
    if(!(every>=2 && every<=6)) return;
    if(!start) return;
    p.meds[m].schedule = { type:"interval", every, start };
  }

  saveState();
  medDlg.close();
  renderAll();
};

function toggleDose(med, schedTime){
  const p = ensurePatient(selectedPatient);
  const md = p.meds[med];
  const dayKey = ymd(currentDay);

  md.history = md.history || {};
  md.history[dayKey] = md.history[dayKey] || [];
  const arr = md.history[dayKey];

  const idx = arr.findIndex(x=>x && x.sched===schedTime);
  if(idx >= 0){
    arr.splice(idx, 1);
    saveState();
    renderAll();
    return;
  }

  if(!currentInitials){
    openInitialsDialog();
    return;
  }

  const now = new Date();
  const sched = dtForDay(currentDay, schedTime);
  const diff = minutesDiff(now, sched);
  const status = diff <= 60 ? "ok" : "late";

  arr.push({
    sched: schedTime,
    given: pad2(now.getHours()) + ":" + pad2(now.getMinutes()),
    status,
    initials: currentInitials
  });

  saveState();
  renderAll();

  if(status==="late"){
    warnDetail.textContent = `Scheduled ${schedTime} · Given ${pad2(now.getHours())}:${pad2(now.getMinutes())} ${currentInitials} · Diff ${Math.round(diff)} min`;
    warnDlg.showModal();
  }
}
warnClose.onclick = ()=>warnDlg.close();

document.getElementById("prevDayBtn").onclick = ()=>{ currentDay = new Date(currentDay.getTime()-86400000); currentDay.setHours(0,0,0,0); renderAll(); };
document.getElementById("nextDayBtn").onclick = ()=>{ currentDay = new Date(currentDay.getTime()+86400000); currentDay.setHours(0,0,0,0); renderAll(); };
datePicker.addEventListener("change", ()=>{
  const d = parseISODate(datePicker.value);
  if(!d) return;
  currentDay = d;
  renderAll();
});

/* ===========================
   Print (monthly)
=========================== */
function daysInMonth(date){ return new Date(date.getFullYear(), date.getMonth()+1, 0).getDate(); }
function fmtMonthTitle(date){ return date.getFullYear() + "-" + pad2(date.getMonth()+1); }

function buildMonthlyPrintHTML(patientName, monthDate){
  const patient = ensurePatient(patientName);
  const meds = patient.meds || {};
  const medNames = Object.keys(meds).sort((a,b)=>a.localeCompare(b));

  const y = monthDate.getFullYear();
  const m = monthDate.getMonth();
  const dim = daysInMonth(monthDate);

  const rows = [];
  for(const med of medNames){
    const times = meds[med].times || [];
    for(const t of times) rows.push({med, time:t});
  }

  const lookup = {}; // key day||med||time -> rec
  for(let day=1; day<=dim; day++){
    const d = new Date(y, m, day, 0,0,0,0);
    const dayKey = ymd(d);
    for(const med of medNames){
      if(!isMedActiveOnDate(meds[med], d)) continue;
      const hist = (meds[med].history && meds[med].history[dayKey]) ? meds[med].history[dayKey] : [];
      const bySched = {};
      hist.forEach(r=>{ if(r && r.sched) bySched[r.sched]=r; });
      (meds[med].times||[]).forEach(t=>{
        const rec = bySched[t];
        if(rec) lookup[`${day}||${med}||${t}`] = rec;
      });
    }
  }

  let thead = `<tr><th style="width:230px; text-align:left; padding-left:6px;">MEDICATIONS</th><th style="width:60px;">HOUR</th>`;
  for(let day=1; day<=dim; day++) thead += `<th>${day}</th>`;
  thead += `</tr>`;

  let tbody = "";
  for(const r of rows){
    tbody += `<tr>`;
    tbody += `<td style="text-align:left; padding-left:6px; font-weight:700;">${escapeHtml(r.med)}</td>`;
    tbody += `<td style="font-weight:700;">${escapeHtml(r.time)}</td>`;
    for(let day=1; day<=dim; day++){
      const rec = lookup[`${day}||${r.med}||${r.time}`];
      const txt = rec ? `${rec.given || ""} ${(rec.initials||"")}`.trim() : "";
      tbody += `<td style="height:18px; font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(txt)}</td>`;
    }
    tbody += `</tr>`;
  }
  if(!tbody){
    tbody = `<tr><td colspan="${dim+2}">No meds</td></tr>`;
  }

  const style = `
    <style>
      @page{ size: landscape; margin: 10mm; }
      body{ font-family: Arial, sans-serif; color:#000; }
      .hdr{ display:flex; justify-content:space-between; align-items:flex-end; border-bottom:2px solid #000; padding-bottom:6px; margin-bottom:8px; }
      .t1{ font-weight:900; font-size:18px; }
      .t2{ font-weight:700; font-size:12px; }
      .meta{ display:flex; gap:18px; font-size:12px; margin:6px 0 10px; }
      table{ border-collapse:collapse; width:100%; table-layout:fixed; }
      th, td{ border:1px solid #000; font-size:10px; padding:2px; text-align:center; vertical-align:middle; }
      th{ background:#f3f3f3; font-weight:800; }
      .foot{ margin-top:10px; font-size:10px; display:flex; justify-content:space-between; color:#333; }
    </style>`;

  // NOTE: print trigger uses body onload; no script tags needed.
  return `
    <!doctype html><html><head><meta charset="utf-8" />
    <title>MAR Print</title>${style}</head>
    <body onload="window.print()">
      <div class="hdr">
        <div class="t1">MEDICATION ADMINISTRATION RECORD</div>
        <div class="t2">Month: ${escapeHtml(fmtMonthTitle(monthDate))}</div>
      </div>
      <div class="meta">
        <div><b>Patient:</b> ${escapeHtml(patientName)}</div>
        <div><b>Printed:</b> ${escapeHtml(new Date().toLocaleString())}</div>
      </div>
      <table><thead>${thead}</thead><tbody>${tbody}</tbody></table>
      <div class="foot"><div>Cell: HH:MM + initials</div><div>Mini MAR (local)</div></div>
    </body></html>`;
}

function doPrint(){
  if(!selectedPatient) return;
  const w = window.open("", "_blank");
  if(!w) return;
  w.document.open();
  w.document.write(buildMonthlyPrintHTML(selectedPatient, currentDay));
  w.document.close();
}
printBtn.onclick = doPrint;

/* ===========================
   Login wiring
=========================== */
async function doLogin(){
  loginErr.textContent = "";
  const facilityCode = facilityInput.value.trim();
  const nurseId = nurseInput.value.trim();
  const password = passInput.value;

  if(!facilityCode || !nurseId || !password){
    loginErr.textContent = "Facility Code / Nurse ID / Password를 모두 입력하세요.";
    return;
  }
  const email = makeEmail(facilityCode, nurseId);

  try{
    await signInWithEmailAndPassword(auth, email, password);
  }catch(e){
    console.error(e);
    loginErr.textContent =
      `Login failed.\nEmail used: ${email}\nError: ${(e && e.code) ? e.code : ""} ${(e && e.message) ? e.message : ""}`;
  }
}
loginBtn.onclick = doLogin;
passInput.addEventListener("keydown", (ev)=>{ if(ev.key==="Enter") doLogin(); });

demoBtn.onclick = ()=>{
  loginOverlay.style.display = "none";
  appRoot.style.display = "flex";
  currentEmail = null;
  currentInitials = loadInitials("demo") || "DM";
  renderAll();
};

logoutBtn.onclick = async ()=>{
  try{ await signOut(auth); }catch(e){ console.error(e); }
};

onAuthStateChanged(auth, (user)=>{
  if(user){
    loginOverlay.style.display = "none";
    appRoot.style.display = "flex";
    currentEmail = user.email || "(unknown)";
    currentInitials = loadInitials(currentEmail);
    if(!currentInitials) openInitialsDialog();
    renderAll();
  }else{
    loginOverlay.style.display = "flex";
    appRoot.style.display = "none";
    currentEmail = null;
    currentInitials = null;
  }
});

/* initial render */
renderAll();

/* ===========================
   SYNC BRIDGE (minimal, additive)
   - Keep app logic intact, just expose hooks for sync.mjs
=========================== */

// Expose Firebase handles to sync layer
window.__MAR_FB__ = { auth, db };

// Local change listeners (sync subscribes here)
const __marLocalChangeListeners = new Set();
function __emitLocalChange(reason){
  __marLocalChangeListeners.forEach(fn=>{
    try{ fn({ reason: reason || "unknown" }); }catch(_e){}
  });
}

// Wrap saveState() so any local mutation notifies sync
let __lastLocalWriteAt = 0;

const __origSaveState = saveState;
saveState = function(){
  __lastLocalWriteAt = Date.now();
  __origSaveState();
  __emitLocalChange("saveState");
};

// sync.mjs가 읽을 수 있게 노출
window.MAR_APP.getLastLocalWriteAt = ()=>__lastLocalWriteAt;

// Facility parsing helper (from email like n123@AHLTC001.local)
function __parseFacilityFromEmail(email){
  const m = /@([^.]+)\.local$/i.exec(email || "");
  return m ? m[1].toUpperCase() : null;
}

// Expose a small app API (read/write state + subscribe)
window.MAR_APP = {
  getState: ()=> state,
  setState: (next)=>{ state = next; renderAll(); },
  render: ()=> renderAll(),
  onLocalChange: (fn)=>{ __marLocalChangeListeners.add(fn); return ()=>__marLocalChangeListeners.delete(fn); },
  getLastLocalWriteAt: ()=>__lastLocalWriteAt, 
  getFacilityCode: ()=>{
    // Prefer auth email derived facility
    if(auth && auth.currentUser && auth.currentUser.email){
      return __parseFacilityFromEmail(auth.currentUser.email);
    }
    // Fallback: facility input value (may persist)
    const el = document.getElementById("facilityInput");
    return (el && el.value) ? String(el.value).trim().toUpperCase() : null;
  },
};



