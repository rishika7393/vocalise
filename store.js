// One storage interface, three backends. On a deployed site this is
// localStorage. Inside the Claude artifact sandbox localStorage throws, so we
// use window.storage there. If both are unavailable we keep things in memory
// for the session so nothing crashes.

const mem = new Map();
const hasArtifactStore = typeof window !== 'undefined' && !!window.storage;

let hasLocal = false;
try {
  localStorage.setItem('vocalise:probe', '1');
  localStorage.removeItem('vocalise:probe');
  hasLocal = true;
} catch (e) { hasLocal = false; }

export const backend = hasArtifactStore ? 'artifact' : hasLocal ? 'local' : 'memory';

async function readRaw(key){
  try {
    if (backend === 'artifact'){ const r = await window.storage.get(key); return r ? r.value : null; }
    if (backend === 'local') return localStorage.getItem(key);
  } catch (e) { /* missing key, quota, private mode */ }
  return mem.has(key) ? mem.get(key) : null;
}

async function writeRaw(key, value){
  mem.set(key, value);
  try {
    if (backend === 'artifact'){ await window.storage.set(key, value); return true; }
    if (backend === 'local'){ localStorage.setItem(key, value); return true; }
  } catch (e) { /* fall through to memory, already written */ }
  return false;
}

export async function getJSON(key, fallback = null){
  const raw = await readRaw(key);
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

export async function setJSON(key, value){
  return writeRaw(key, JSON.stringify(value));
}

/* ---------- the current exercise, shared across both pages ---------- */

export const SETUP_KEY = 'vocalise:setup';
export const loadSetup = () => getJSON(SETUP_KEY, null);
export const saveSetup = s => setJSON(SETUP_KEY, s);

/* ---------- saved exercises ---------- */

const LIB_KEY = 'vocalise:library';

export async function listExercises(){
  const lib = await getJSON(LIB_KEY, []);
  return Array.isArray(lib) ? lib : [];
}

export async function saveExercise(ex){
  const lib = await listExercises();
  const id = ex.id || 'ex_' + Date.now().toString(36);
  const next = { ...ex, id, savedAt: Date.now() };
  const at = lib.findIndex(e => e.id === id);
  if (at >= 0) lib[at] = next; else lib.unshift(next);
  await setJSON(LIB_KEY, lib.slice(0, 60));
  return next;
}

export async function exportLibrary(){
  const lib = await listExercises();
  const blob = new Blob([JSON.stringify({ version: 1, exercises: lib }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vocalise-exercises-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  return lib.length;
}

export async function importLibrary(file){
  const text = await file.text();
  const data = JSON.parse(text);
  const incoming = Array.isArray(data) ? data          // bare array (old format)
    : Array.isArray(data.exercises) ? data.exercises   // { version, exercises }
    : null;
  if (!incoming) throw new Error('Unrecognised file format.');
  const existing = await listExercises();
  const existingIds = new Set(existing.map(e => e.id));
  let added = 0, skipped = 0;
  for (const ex of incoming){
    if (!ex || typeof ex !== 'object' || !ex.sequence) { skipped++; continue; }
    if (ex.id && existingIds.has(ex.id)){ skipped++; continue; } // already present
    await saveExercise({ ...ex, id: undefined }); // new id to avoid collision
    added++;
  }
  return { added, skipped };
}

export async function deleteExercise(id){
  await setJSON(LIB_KEY, lib.filter(e => e.id !== id));
}
