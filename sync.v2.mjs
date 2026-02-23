/* sync.v2.mjs
   Firestore Sync Layer for Mini MAR (facility isolated)
   FIXES:
   - Prevent "deleted patient comes back" via tombstone (no Firestore delete needed)
   - Prevent remote snapshot overwriting newer local changes via stateRev/stateUpdatedAt guard
   - Keep room/mrn because we always push full patient data as-is
*/

import {
  collection, doc, setDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function waitForGlobals(){
  let tries = 0;
  while(true){
    const ok = window.__MAR_FB__ && window.__MAR_FB__.auth && window.__MAR_FB__.db && window.MAR_APP;
    if(ok) return;

    tries++;
    if(tries % 20 === 0){
      console.warn("SYNC: waiting for hooks... (MAR_APP / __MAR_FB__)",
        "MAR_APP:", !!window.MAR_APP,
        "__MAR_FB__:", !!window.__MAR_FB__);
    }
    await sleep(100);
  }
}

function patientIdFromName(name){
  return encodeURIComponent(String(name || "").trim().toLowerCase());
}
function deepClone(obj){
  return JSON.parse(JSON.stringify(obj || {}));
}
function normalizeState(s){
  if(!s || typeof s !== "object") return { patients:{} };
  if(!s.patients || typeof s.patients !== "object") s.patients = {};
  if(s.__rev === undefined) s.__rev = 0;
  if(s.__updatedAt === undefined) s.__updatedAt = 0;
  return s;
}
function debounce(fn, ms){
  let t = null;
  return (...args)=>{
    if(t) clearTimeout(t);
    t = setTimeout(()=>fn(...args), ms);
  };
}
function safeText(s){
  return (s === null || s === undefined) ? "" : String(s);
}
function setStatusHint(msg){
  const el = document.getElementById("whoPill");
  if(!el) return;
  if(msg){
    el.dataset.syncHint = msg;
    if(!el.textContent.includes("SYNC:")){
      el.textContent = el.textContent + " · SYNC:" + msg;
    }else{
      el.textContent = el.textContent.replace(/ · SYNC:.*$/," · SYNC:"+msg);
    }
  }
}

(async function main(){
  await waitForGlobals();

  const { auth, db } = window.__MAR_FB__;
  const APP = window.MAR_APP;

  let facilityCode = null;

  // Prevent remote-apply from echoing back to remote immediately
  let applyingRemote = false;

  // Whether we received the first snapshot
  let remoteReady = false;

  // Track last server state hash-ish to reduce redundant writes
  let lastPushedJson = "";

  // Track current remote patient doc IDs (so we can tombstone missing ones)
  let lastRemoteIds = new Set();

  function patientsColRef(){
    return collection(db, "facilities", facilityCode, "patients");
  }

  function localMeta(){
    const s = normalizeState(deepClone(APP.getState()));
    return {
      stateRev: Number(s.__rev) || 0,
      stateUpdatedAt: Number(s.__updatedAt) || 0
    };
  }

  async function pushAllPatients(){
    const s = normalizeState(deepClone(APP.getState()));
    const patients = s.patients || {};
    const names = Object.keys(patients);

    // push only if changed (coarse)
    const json = JSON.stringify({ patients, __rev: s.__rev, __updatedAt: s.__updatedAt });
    if(json === lastPushedJson) return;
    lastPushedJson = json;

    const meta = localMeta();

    // 1) Upsert all existing local patients
    for(const name of names){
      const pid = patientIdFromName(name);
      const ref = doc(db, "facilities", facilityCode, "patients", pid);

      await setDoc(ref, {
        name,
        deleted: false,
        data: patients[name],             // includes meds + room + mrn
        schemaVersion: 2,
        stateRev: meta.stateRev,
        stateUpdatedAt: meta.stateUpdatedAt,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser.uid,
        updatedByEmail: auth.currentUser.email || null
      }, { merge: true });
    }

    // 2) Tombstone patients that exist remotely but not locally (prevents "comes back")
    //    We DO NOT Firestore-delete (rules may block). We mark deleted:true.
    const localIds = new Set(names.map(n => patientIdFromName(n)));
    const toTombstone = [];
    lastRemoteIds.forEach(pid=>{
      if(!localIds.has(pid)) toTombstone.push(pid);
    });

    for(const pid of toTombstone){
      const ref = doc(db, "facilities", facilityCode, "patients", pid);
      await setDoc(ref, {
        deleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: auth.currentUser.uid,
        deletedByEmail: auth.currentUser.email || null,
        // also stamp meta so other clients see this as newest
        schemaVersion: 2,
        stateRev: meta.stateRev,
        stateUpdatedAt: meta.stateUpdatedAt,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser.uid,
        updatedByEmail: auth.currentUser.email || null
      }, { merge: true });
    }
  }

  function applyRemoteSnapshot(snap){
    // Guard 1) If we just wrote locally, don't immediately overwrite local UI with remote.
    // BUT we still mark remoteReady so we can push local changes to other devices.
    const lastLocal = APP.getLastLocalWriteAt ? (APP.getLastLocalWriteAt() || 0) : 0;
    const skipApply = (Date.now() - lastLocal < 1200);

    // Build next state from remote (ignore deleted tombstones) from remote (ignore deleted tombstones)
    const next = { patients:{} };

    // Track remote ids + find "max" meta to compare freshness
    const remoteIds = new Set();
    let remoteMaxRev = 0;
    let remoteMaxUpdatedAt = 0;

    snap.forEach(d=>{
      remoteIds.add(d.id);

      const v = d.data() || {};
      if(v.deleted === true) return; // ✅ ignore tombstoned patient docs

      const name = v.name || decodeURIComponent(d.id);
      next.patients[name] = v.data || { meds:{} };

      const rrev = Number(v.stateRev) || 0;
      const rupd = Number(v.stateUpdatedAt) || 0;
      if(rrev > remoteMaxRev) remoteMaxRev = rrev;
      if(rupd > remoteMaxUpdatedAt) remoteMaxUpdatedAt = rupd;
    });

    lastRemoteIds = remoteIds;

    // We received a snapshot; allow pushes even if we don't apply it.
    remoteReady = true;
    setStatusHint("OK");
    if(skipApply) return;

    // Guard 2) Don't apply if remote is not newer than local
    const local = normalizeState(deepClone(APP.getState()));
    const localRev = Number(local.__rev) || 0;
    const localUpd = Number(local.__updatedAt) || 0;

    // Remote snapshot is older or same -> ignore (prevents delete/room/mrn revert)
    if(remoteMaxRev < localRev) return;
    if(remoteMaxRev === localRev && remoteMaxUpdatedAt <= localUpd) return;

    applyingRemote = true;
    try{
      APP.setState(normalizeState(next));
      remoteReady = true;
      setStatusHint("OK");
    } finally {
      setTimeout(()=>{ applyingRemote = false; }, 0);
    }
  }

  const schedulePush = debounce(async ()=>{
    if(!auth.currentUser) return;
    if(!facilityCode) return;
    if(!remoteReady) return;
    if(applyingRemote) return;

    try{
      setStatusHint("push…");
      await pushAllPatients();
      setStatusHint("OK");
    }catch(e){
      console.error("SYNC push error:", e);
      setStatusHint("ERR");
      lastPushedJson = "";
    }
  }, 600);

  // Subscribe to local changes
  APP.onLocalChange(()=>{
    schedulePush();
  });

  // Start/stop facility subscription on auth change (polling)
  let lastUid = null;
  let unsubPatients = null;

  let preSnapshotLocalPatientsJson = null;

  setInterval(async ()=>{
    const u = auth.currentUser;
    const uid = u ? u.uid : null;

    if(uid === lastUid) return;
    lastUid = uid;

    if(unsubPatients){
      try{ unsubPatients(); }catch(_e){}
      unsubPatients = null;
    }
    remoteReady = false;
    applyingRemote = false;
    lastPushedJson = "";
    lastRemoteIds = new Set();

    if(!u){
      setStatusHint("");
      console.log("SYNC: signed out");
      return;
    }

    facilityCode = APP.getFacilityCode();
    facilityCode = safeText(facilityCode).trim().toUpperCase();
    if(!facilityCode){
      console.warn("SYNC: facilityCode not found; sync disabled");
      setStatusHint("NOFAC");
      return;
    }

    // Backup local before remote overrides it (for bootstrap)
    try{
      const local = normalizeState(deepClone(APP.getState()));
      preSnapshotLocalPatientsJson = JSON.stringify(local.patients || {});
    }catch(_e){
      preSnapshotLocalPatientsJson = null;
    }

    console.log("SYNC: start facility", facilityCode, "uid", uid);
    setStatusHint("sub…");

    unsubPatients = onSnapshot(
      patientsColRef(),
      async (snap)=>{
        const isEmpty = snap.empty;

        applyRemoteSnapshot(snap);

        // Bootstrap: remote empty + local had patients before snapshot => push them up once
        if(isEmpty && preSnapshotLocalPatientsJson && preSnapshotLocalPatientsJson !== "{}"){
          try{
            applyingRemote = true;
            const restored = { patients: JSON.parse(preSnapshotLocalPatientsJson), __rev: 1, __updatedAt: Date.now() };
            APP.setState(normalizeState(restored));
          } finally {
            applyingRemote = false;
          }

          try{
            setStatusHint("bootstrap…");
            await pushAllPatients();
            setStatusHint("OK");
          }catch(e){
            console.error("SYNC bootstrap error:", e);
            setStatusHint("ERR");
          } finally {
            preSnapshotLocalPatientsJson = null;
          }
        }else{
          preSnapshotLocalPatientsJson = null;
        }
      },
      (err)=>{
        console.error("SYNC onSnapshot error:", err);
        setStatusHint("ERR");
      }
    );

  }, 400);

})();
