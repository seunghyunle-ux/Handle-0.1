/* sync.mjs
   Firestore Sync Layer for Mini MAR (facility isolated)
   - Works with your existing Firestore Rules (sameFacility + role)
   - No deletes (since delete is admin-only)
   - Patient doc stores full local patient object under { data: ... }
*/

import {
  collection, doc, setDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function waitForGlobals(){
  for(let i=0;i<200;i++){
    if(window.__MAR_FB__ && window.__MAR_FB__.auth && window.__MAR_FB__.db && window.MAR_APP){
      return;
    }
    await sleep(50);
  }
  throw new Error("sync.mjs: window hooks not found (MAR_APP / __MAR_FB__)");
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
  // Optional: show tiny hint in whoPill (won't break if missing)
  const el = document.getElementById("whoPill");
  if(!el) return;
  // Keep it short; preserve main text as much as possible
  if(msg){
    el.dataset.syncHint = msg;
    // Don’t permanently overwrite app’s own whoPill, just append
    if(!el.textContent.includes("SYNC:")){
      el.textContent = el.textContent + " · SYNC:" + msg;
    }else{
      // replace last SYNC part
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

  function patientsColRef(){
    return collection(db, "facilities", facilityCode, "patients");
  }

  async function pushAllPatients(){
    const s = normalizeState(deepClone(APP.getState()));
    const patients = s.patients || {};
    const names = Object.keys(patients);

    // push only if changed (coarse)
    const json = JSON.stringify(patients);
    if(json === lastPushedJson) return;
    lastPushedJson = json;

    for(const name of names){
      const pid = patientIdFromName(name);
      const ref = doc(db, "facilities", facilityCode, "patients", pid);

      await setDoc(ref, {
        name,
        data: patients[name],
        schemaVersion: 1,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser.uid,
        updatedByEmail: auth.currentUser.email || null
      }, { merge: true });
    }
  }

  function applyRemoteSnapshot(snap){
    const next = { patients:{} };

    snap.forEach(d=>{
      const v = d.data() || {};
      const name = v.name || decodeURIComponent(d.id);
      next.patients[name] = v.data || { meds:{} };
    });

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
      // Keep lastPushedJson so we will retry on next change; optional:
      lastPushedJson = "";
    }
  }, 600);

  // Subscribe to local changes (saveState wrapper triggers this)
  APP.onLocalChange(()=>{
    schedulePush();
  });

  // Start/stop facility subscription on auth change (polling)
  let lastUid = null;
  let unsubPatients = null;

  async function bootstrapIfRemoteEmpty(){
    // if remote is empty AND local has data -> upload once
    // wait a moment for first snapshot
    for(let i=0;i<30;i++){
      if(remoteReady) break;
      await sleep(100);
    }
    if(!remoteReady) return;

    // If remote has 0 docs, upload local
    // We can infer emptiness because current local state after snapshot will have 0 patients
    // BUT we want to check "before snapshot overwrote local" in some cases.
    // For simplicity: if snapshot gave 0 and local has some (rare after overwrite), user can re-add.
    // Better approach: keep preSnapshot local backup. We'll do that.
  }

  let preSnapshotLocalPatientsJson = null;

  setInterval(async ()=>{
    const u = auth.currentUser;
    const uid = u ? u.uid : null;

    if(uid === lastUid) return;
    lastUid = uid;

    // stop previous
    if(unsubPatients){
      try{ unsubPatients(); }catch(_e){}
      unsubPatients = null;
    }
    remoteReady = false;
    applyingRemote = false;
    lastPushedJson = "";

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
          // restore local patients into state, then push
          try{
            applyingRemote = true;
            const restored = { patients: JSON.parse(preSnapshotLocalPatientsJson) };
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
