import {
  SHARP, FLAT, FLAT_PC, SOLFEGE, SCALES, PRESETS, LO, HI,
  degToSemi, pcOf, octOf, nameOf, fullName, useFlats, seqToText,
  LENGTHS, normalizeSequence, isUniform,
} from './theory.js';
import {
  keyboardWindow, buildKeyboard,
  paintKeys as paintKeysRaw,
  paintContour as paintContourRaw,
} from './visual.js';
import { Audio, primeOnFirstGesture } from './audio.js';
import { Runner } from './runner.js';
import * as store from './store.js';
const { exportLibrary, importLibrary } = store;

const $ = id => document.getElementById(id);

/* ============================================================
   State
   ============================================================ */
const state = {
  rootPc: 0, rootOct: 4, scale: 'major',
  sequence: normalizeSequence([1, 2, 3, 2, 1], 2),
  mode: 'ladder',
  bpm: 84, noteLen: 2,
  up: 12, down: -5,
  playRoot: true, stopEnd: false, countIn: false,
  metro: false, drone: false,
  sticky: false,
  voice: 'triangle', vol: -6,
};
const SAVE_KEYS = Object.keys(state);
let selStep = -1;
let kbWindow = [48, 84];

const audio = new Audio();
const runner = new Runner(audio);

const rootMidi = () => (state.rootOct + 1) * 12 + state.rootPc;
const flat     = () => useFlats(state.rootPc);
const steps    = () => SCALES[state.scale].steps;
const MAX_SEQ  = Infinity;

function cfg(){
  return {
    rootMidi: rootMidi(), scaleSteps: steps(), sequence: state.sequence,
    mode: state.mode, bpm: state.bpm,
    up: state.up, down: state.down,
    playRoot: state.playRoot, stopEnd: state.stopEnd,
    countIn: state.countIn && state.mode === 'ladder',
    metro: state.metro, drone: state.drone,
    sticky: state.sticky,
  };
}

/* ============================================================
   Painting
   ============================================================ */
function paintReadout(s){
  const el = $('pitch');
  if (!s){
    el.className = 'pitch idle';
    el.innerHTML = nameOf(rootMidi(), flat()) + '<sup>' + octOf(rootMidi()) + '</sup>';
    $('gloss').innerHTML = '<span>' + SCALES[state.scale].label.toLowerCase() + '</span><span>' +
      state.sequence.filter(x => x.d !== null).length + ' notes</span>';
    return;
  }
  if (s.countBeat){
    el.className = 'pitch count';
    el.textContent = s.countBeat;
    $('gloss').innerHTML = '<span>ready</span>';
    return;
  }
  if (s.kind === 'rest'){ el.classList.add('idle'); paintKeys(null); return; }
  if (s.kind === 'hold') return;

  el.className = 'pitch' + (s.kind === 'root' ? ' tonic' : '');
  el.innerHTML = nameOf(s.midi, flat()) + '<sup>' + octOf(s.midi) + '</sup>';
  const semi = pcOf(s.midi - (rootMidi() + s.transpose));
  $('gloss').innerHTML = s.kind === 'root'
    ? '<span>starting note</span>'
    : '<span>degree <b>' + s.deg + '</b></span><span><b>' + SOLFEGE[semi] + '</b></span>';
  paintKeys(s.midi, s.kind === 'root');
  paintContour(s.kind === 'note' ? s.seq : -1);
}

function computeWindow(){
  kbWindow = keyboardWindow(rootMidi(), state.sequence, steps(), state.down, state.up);
}

function paintKeys(active, isTonic){
  const tonicPc = pcOf(rootMidi() + (runner.playing ? runner.transpose : 0));
  paintKeysRaw($('kb'), tonicPc, steps(), active != null ? [{ midi: active, cls: isTonic ? 'tonic' : 'on' }] : []);
}

function paintContour(active){
  paintContourRaw($('contour'), state.sequence, steps(), { active });
}

function paintLengths(){
  const cur = selStep >= 0 && state.sequence[selStep] ? state.sequence[selStep].len : state.noteLen;
  $('lenchips').innerHTML = LENGTHS.map(l =>
    '<button class="chip' + (l.ticks === cur ? ' sel' : '') + '" data-len="' + l.ticks +
    '" title="' + l.name + '">' + l.label + '</button>').join('');
  $('lenlabel').textContent = selStep >= 0 ? 'Step ' + (selStep + 1) : 'New note';
}

function paintLadder(){
  let out = '';
  for (let t = state.down; t <= state.up; t++){
    const here = runner.playing && t === runner.transpose;
    const passed = runner.playing && (runner.dir > 0 ? t < runner.transpose : t > runner.transpose);
    const cls = ['rung'];
    if (t === 0) cls.push('home');
    if (passed) cls.push('passed');
    if (here){ cls.push('here'); if (runner.dir < 0) cls.push('down'); }
    out += '<div class="' + cls.join(' ') + '"></div>';
  }
  $('rungs').innerHTML = out;

  if (runner.playing){
    const sign = runner.transpose > 0 ? '+' : '';
    $('ladderpos').textContent = 'Starting on ' + fullName(rootMidi() + runner.transpose, flat()) +
      '  ·  ' + sign + runner.transpose + ' st';
    $('ladderdir').textContent = runner.dir > 0 ? 'climbing' : 'descending';
    $('ladderdir').classList.toggle('down', runner.dir < 0);
  } else {
    $('ladderpos').textContent = state.mode === 'learn'
      ? 'One pass on ' + fullName(rootMidi(), flat())
      : state.mode === 'loop'
      ? 'Looping on ' + fullName(rootMidi(), flat())
      : '+' + state.up + ' / −' + Math.abs(state.down) + ' semitones';
    $('ladderdir').textContent = '';
  }
}

function paintStrip(){
  $('modeseg').querySelectorAll('button').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  $('subdivseg').querySelectorAll('button').forEach(b =>
    b.setAttribute('aria-pressed', String(+b.dataset.t === state.noteLen && isUniform(state.sequence))));
  $('metro').setAttribute('aria-pressed', String(state.metro));
  $('drone').setAttribute('aria-pressed', String(state.drone));
  $('bpmread').innerHTML = state.bpm + ' <span>bpm</span>';
}

function paintTransport(){
  $('play').textContent = runner.playing ? 'Stop' : 'Start';
  $('play').classList.toggle('on', runner.playing);
  $('turn').disabled = !runner.playing || state.mode !== 'ladder';
  $('nowset').innerHTML = '<b>' + nameOf(rootMidi(), flat()) + octOf(rootMidi()) + ' ' +
    SCALES[state.scale].label.toLowerCase() + '</b> · ' + seqToText(state.sequence) + ' · ♩=' + state.bpm;
}

function paintSeq(){
  const box = $('seqbox');
  if (!state.sequence.length){
    box.innerHTML = '<span class="empty">Build a sequence below, or choose a preset.</span>';
    paintLengths();
    return;
  }
  box.innerHTML = state.sequence.map((st, i) => {
    const w = (1.4 + Math.max(1, st.len) * 0.32).toFixed(2);
    return '<button class="step' + (st.d === null ? ' rest' : '') + (i === selStep ? ' sel' : '') +
      '" data-i="' + i + '" style="min-width:' + w + 'rem">' +
      (st.d === null ? '\u00b7' : st.d) + '</button>';
  }).join('');
  paintLengths();
}

function refresh(){
  computeWindow();
  buildKeyboard($('kb'), kbWindow);
  wireKb();
  paintKeys(null);
  paintSeq();
  paintContour(-1);
  paintReadout(null);
  paintLadder();
  paintStrip();
  paintTransport();
  save();
}

/* ============================================================
   Playable keyboard
   ============================================================ */
function wireKb(){
  $('kb').querySelectorAll('[data-midi]').forEach(el => {
    const m = +el.dataset.midi;
    const press = async () => {
      await audio.prime();
      audio.note(m, 0.6);
      el.classList.add('pressed');
      paintReadout({ kind:'note', midi:m, deg:null, seq:-1, transpose:0 });
    };
    const release = () => el.classList.remove('pressed');
    el.addEventListener('pointerdown', e => { e.preventDefault(); press(); el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
  });
}

/* ============================================================
   Controls
   ============================================================ */
function buildControls(){
  // root chips
  $('roots').innerHTML = SHARP.map((n, i) =>
    '<button class="chip' + (i === state.rootPc ? ' sel' : '') + '" data-pc="' + i + '">' +
    (FLAT_PC.includes(i) ? SHARP[i] + '/' + FLAT[i] : n) + '</button>').join('');

  // octave select
  $('oct').innerHTML = [2, 3, 4, 5].map(o =>
    '<option value="' + o + '"' + (o === state.rootOct ? ' selected' : '') + '>' +
    nameOf(state.rootPc, flat()) + o + '</option>').join('');

  // scale select
  $('scale').innerHTML = Object.entries(SCALES).map(([k, v]) =>
    '<option value="' + k + '"' + (k === state.scale ? ' selected' : '') + '>' + v.label + '</option>').join('');

  // degree buttons
  const shift = +$('octshift').value;
  const degs = [1,2,3,4,5,6,7,8,9,10,11,12].map(d => d + shift * 7);
  $('degrees').innerHTML = degs.map(d =>
    '<button class="chip" data-deg="' + d + '">' + d + '</button>').join('') +
    '<button class="chip" data-deg="rest">rest</button>';

  // preset / saved list
  buildPresetList();
}

async function buildPresetList(){
  const saved = await store.listExercises();
  const sel = $('preset');
  const prev = sel.value;
  let html = '';
  saved.forEach(e => {
    html += '<option class="saved-opt" value="s:' + e.id + '">' + escHtml(e.name) + '</option>';
  });
  PRESETS.forEach((p, i) => {
    html += '<option value="p:' + i + '">' + p.label + '</option>';
  });
  sel.innerHTML = html;
  // Try to restore selection
  if (prev) sel.value = prev;
  $('prestempty').hidden = saved.length > 0;
}

function structuralChange(){
  if (runner.playing) runner.stop();
  buildControls();
  refresh();
}

/* ============================================================
   Wire everything
   ============================================================ */
function wire(){
  // roots
  $('roots').onclick = e => {
    const b = e.target.closest('[data-pc]'); if (!b) return;
    state.rootPc = +b.dataset.pc; structuralChange();
  };
  $('oct').onchange = e => { state.rootOct = +e.target.value; structuralChange(); };
  $('scale').onchange = e => { state.scale = e.target.value; structuralChange(); };
  $('octshift').onchange = buildControls;

  // degree buttons add to sequence (max 12)
  $('degrees').onclick = e => {
    const b = e.target.closest('[data-deg]'); if (!b) return;
    state.sequence.push({ d: b.dataset.deg === 'rest' ? null : +b.dataset.deg, len: state.noteLen });
    selStep = state.sequence.length - 1;
    $('preset').selectedIndex = -1;
    structuralChange();
  };

  // tap a step to select/deselect
  $('seqbox').onclick = e => {
    const b = e.target.closest('[data-i]'); if (!b) return;
    const i = +b.dataset.i;
    selStep = selStep === i ? -1 : i;
    paintSeq();
  };

  // length chips
  $('lenchips').onclick = e => {
    const b = e.target.closest('[data-len]'); if (!b) return;
    const len = +b.dataset.len;
    if (selStep >= 0 && state.sequence[selStep]){
      state.sequence[selStep].len = len;
      structuralChange();
    } else {
      state.noteLen = len;
      paintLengths(); paintStrip(); save();
    }
  };

  $('undo').onclick = () => {
    state.sequence.pop(); selStep = Math.min(selStep, state.sequence.length - 1);
    structuralChange();
  };
  $('evenout').onclick = () => {
    state.sequence.forEach(st => { st.len = state.noteLen; });
    structuralChange();
  };
  $('clear').onclick = () => { state.sequence = []; selStep = -1; structuralChange(); };

  // preset list: Load / Delete buttons
  $('presload').onclick = async () => {
    const v = $('preset').value;
    if (!v) return;
    if (v.startsWith('s:')){
      const lib = await store.listExercises();
      const ex = lib.find(x => x.id === v.slice(2));
      if (!ex) return;
      loadExercise(ex);
    } else if (v.startsWith('p:')){
      const p = PRESETS[+v.slice(2)];
      if (!p) return;
      state.sequence = normalizeSequence(p.seq, state.noteLen);
      selStep = -1;
      structuralChange();
    }
  };

  $('presdel').onclick = async () => {
    const v = $('preset').value;
    if (!v || !v.startsWith('s:')) return;
    await store.deleteExercise(v.slice(2));
    buildPresetList();
  };

  // save
  $('savego').onclick = doSave;
  $('savename').onkeydown = e => { if (e.key === 'Enter') doSave(); };

  // strip
  $('modeseg').onclick = e => {
    const b = e.target.closest('[data-mode]'); if (!b) return;
    state.mode = b.dataset.mode; structuralChange();
  };
  $('subdivseg').onclick = e => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    state.noteLen = +b.dataset.t;
    if (isUniform(state.sequence)) state.sequence.forEach(st => { st.len = state.noteLen; });
    structuralChange();
  };
  $('metro').onclick = () => {
    state.metro = !state.metro;
    if (runner.playing) runner.cfg.metro = state.metro;
    paintStrip(); save();
  };
  $('drone').onclick = () => {
    state.drone = !state.drone;
    if (runner.playing){ runner.cfg.drone = state.drone; audio.drone(state.drone, rootMidi() + runner.transpose); }
    paintStrip(); save();
  };

  // tempo
  const setBpm = v => {
    state.bpm = Math.max(40, Math.min(200, Math.round(v)));
    runner.setTempo(state.bpm);
    paintStrip(); paintTransport(); save();
  };
  $('bpmup').onclick = () => setBpm(state.bpm + 1);
  $('bpmdown').onclick = () => setBpm(state.bpm - 1);
  $('bpmread').onkeydown = e => {
    if (e.key === 'ArrowUp'){ e.preventDefault(); setBpm(state.bpm + 1); }
    if (e.key === 'ArrowDown'){ e.preventDefault(); setBpm(state.bpm - 1); }
  };
  let drag = null;
  $('bpmread').addEventListener('pointerdown', e => {
    drag = { y: e.clientY, bpm: state.bpm };
    $('bpmread').setPointerCapture(e.pointerId);
  });
  $('bpmread').addEventListener('pointermove', e => {
    if (!drag) return; setBpm(drag.bpm + Math.round((drag.y - e.clientY) / 3));
  });
  $('bpmread').addEventListener('pointerup', () => { drag = null; });

  let taps = [];
  $('tap').onclick = () => {
    const now = performance.now();
    taps = taps.filter(t => now - t < 2500); taps.push(now);
    if (taps.length >= 2){
      const gaps = taps.slice(1).map((t, i) => t - taps[i]);
      setBpm(60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length));
    }
  };

  // settings
  const range = (id, key, fmt, after) => {
    const el = $(id); el.value = state[key];
    const paint = () => { $(id + 'val').textContent = fmt(state[key]); };
    paint();
    el.oninput = () => { state[key] = +el.value; paint(); after && after(); };
  };
  range('up',  'up',  v => '+' + v + ' st',  structuralChange);
  range('down','down',v => v + ' st',         structuralChange);
  range('vol', 'vol', v => v + ' dB', () => { audio.setVolume(state.vol); save(); });

  const check = (id, key, after) => {
    const el = $(id); el.checked = state[key];
    el.onchange = () => { state[key] = el.checked; after ? after() : save(); };
  };
  check('playroot', 'playRoot', structuralChange);
  check('stopend',  'stopEnd');
  check('countin',  'countIn');
  check('sticky',   'sticky',  save);

  $('voice').value = state.voice;
  $('voice').onchange = e => { state.voice = e.target.value; audio.setVoice(state.voice); save(); };

  // transport
  $('play').onclick = () => runner.playing ? runner.stop() : go();
  $('turn').onclick = () => {
    runner.turn();
    $('turn').textContent = 'Turning…';
    setTimeout(() => { $('turn').textContent = 'Turn around'; }, 900);
  };

  // contour tapping
  $('contour').addEventListener('click', e => {
    const hit = e.target.closest('[data-seq]'); if (!hit) return;
    const i = +hit.dataset.seq;
    if (runner.playing) runner.jumpTo(i);
    else previewNote(i);
  });
  $('contour').addEventListener('keydown', e => {
    const hit = e.target.closest && e.target.closest('[data-seq]'); if (!hit) return;
    if (e.key === 'Enter' || e.code === 'Space'){ e.preventDefault();
      const i = +hit.dataset.seq;
      if (runner.playing) runner.jumpTo(i); else previewNote(i);
    }
  });

  // ⓘ tooltip toggles
  document.querySelectorAll('.ibutton').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = document.getElementById('tip-' + btn.dataset.tip);
      if (t) t.hidden = !t.hidden;
    });
  });

  // tabs
  document.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-pane]'); if (!b) return;
    document.querySelectorAll('.tabs button').forEach(x =>
      x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.pane').forEach(p =>
      p.hidden = p.id !== 'pane-' + b.dataset.pane);
  });

  // export / import
  $('exportbtn').onclick = async () => {
    const n = await exportLibrary();
    if (!n){ notice('Nothing to export — save some exercises first.'); return; }
  };
  $('importbtn').onclick = () => $('importfile').click();
  $('importfile').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const { added, skipped } = await importLibrary(file);
      const msg = 'Imported ' + added + ' exercise' + (added !== 1 ? 's' : '') +
        (skipped ? ' · ' + skipped + ' skipped (already present or invalid).' : '.');
      const r = $('importresult');
      r.textContent = msg; r.style.display = '';
      buildPresetList();
      setTimeout(() => { r.style.display = 'none'; }, 5000);
    } catch (err) {
      notice('Import failed: ' + err.message);
    }
    e.target.value = '';
  };
  $('cmdgo').onclick = () => runCommand($('cmd').value);
  $('cmd').onkeydown = e => { if (e.key === 'Enter') runCommand($('cmd').value); };

  // keyboard shortcuts
  document.addEventListener('keydown', e => {
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'BUTTON' || t === 'TEXTAREA') return;
    if (e.target.closest && e.target.closest('[data-seq]')) return;
    if (e.code === 'Space'){ e.preventDefault(); runner.playing ? runner.stop() : go(); }
    else if (e.key === 'ArrowUp'){ e.preventDefault(); nudgeRoot(1); }
    else if (e.key === 'ArrowDown'){ e.preventDefault(); nudgeRoot(-1); }
    else if (e.key === 'ArrowRight'){ e.preventDefault(); setBpm(state.bpm + 2); }
    else if (e.key === 'ArrowLeft'){ e.preventDefault(); setBpm(state.bpm - 2); }
    else if (e.key === 't' && runner.playing) $('turn').click();
  });
}

function nudgeRoot(n){
  const m = rootMidi() + n;
  if (m < LO || m > HI) return;
  state.rootPc = pcOf(m); state.rootOct = octOf(m);
  structuralChange();
}

/* ============================================================
   Go / preview
   ============================================================ */
async function go(){
  if (!audio.loaded){ notice('Sound could not load. Check the connection and reload.'); return; }
  await audio.prime();
  hideNotice();
  const ok = runner.start(cfg(), {
    onStep: paintReadout,
    onRep:  () => { paintLadder(); paintContour(-1); },
    onJump: i => paintContour(i),
    onStop: () => { paintTransport(); paintReadout(null); paintLadder(); paintContour(-1); paintKeys(null); },
    onEnd:  paintTransport,
    onError: notice,
  });
  if (ok) paintTransport();
}

async function previewNote(i){
  const st = state.sequence[i];
  if (!st || st.d === null) return;
  await audio.prime();
  const midi = rootMidi() + degToSemi(st.d, steps());
  audio.note(midi, 0.55);
  paintReadout({ kind:'note', midi, deg: st.d, seq: i, transpose: 0 });
}

function notice(msg){ const n = $('notice'); n.textContent = msg; n.hidden = false; }
function hideNotice(){ if (audio.loaded) $('notice').hidden = true; }

/* ============================================================
   Saved / preset list
   ============================================================ */
function loadExercise(ex){
  ['rootPc','rootOct','scale','bpm','mode','up','down'].forEach(k => {
    if (ex[k] !== undefined) state[k] = ex[k];
  });
  state.noteLen = ex.noteLen !== undefined ? ex.noteLen : (ex.ticksPerStep || state.noteLen);
  state.sequence = normalizeSequence(ex.sequence, state.noteLen);
  selStep = -1;
  ['up','down','vol'].forEach(k => { if ($(k)) $(k).value = state[k]; });
  if ($('upval')) $('upval').textContent = '+' + state.up + ' st';
  if ($('downval')) $('downval').textContent = state.down + ' st';
  structuralChange();
}

async function doSave(){
  if (!state.sequence.some(st => st.d !== null)){ notice('Nothing to save — sequence is empty.'); return; }
  const name = ($('savename').value || '').trim() || autoName();
  await store.saveExercise({
    name,
    rootPc: state.rootPc, rootOct: state.rootOct, scale: state.scale,
    sequence: state.sequence.map(st => ({ ...st })),
    bpm: state.bpm, noteLen: state.noteLen, mode: state.mode,
    up: state.up, down: state.down,
  });
  $('savename').value = '';
  hideNotice();
  buildPresetList();
}

function autoName(){
  return nameOf(rootMidi(), flat()) + octOf(rootMidi()) + ' ' +
    SCALES[state.scale].label.toLowerCase() + ' · ' + seqToText(state.sequence);
}

function escHtml(s){
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

/* ============================================================
   Command bar
   ============================================================ */
function runCommand(raw){
  if (!raw.trim()) return;
  let s = ' ' + raw.toLowerCase().replace(/[–—]/g, '-') + ' ';
  const changed = [];

  const bpmM = s.match(/(\d{2,3})\s*(?:bpm|beats)|(?:bpm|tempo|at)\s*(\d{2,3})/);
  if (bpmM){
    const v = +(bpmM[1] || bpmM[2]);
    if (v >= 40 && v <= 200){ state.bpm = v; changed.push('tempo'); }
    s = s.replace(bpmM[0], ' ');
  }
  if (/\blearn\b/.test(s)){ state.mode = 'learn'; s = s.replace(/\blearn\b/, ' '); changed.push('mode'); }
  else if (/\bloop\b/.test(s)){ state.mode = 'loop'; s = s.replace(/\bloop\b/, ' '); changed.push('mode'); }
  else if (/\bladder\b|\bpractice\b|\bdrill\b/.test(s)){
    state.mode = 'ladder'; s = s.replace(/\bladder\b|\bpractice\b|\bdrill\b/, ' '); changed.push('mode');
  }

  const aliases = [];
  Object.entries(SCALES).forEach(([k, v]) => v.alias.forEach(a => aliases.push([a, k])));
  aliases.sort((a, b) => b[0].length - a[0].length);
  for (const [a, k] of aliases){
    const re = new RegExp('\\b' + a.replace(/ /g, '\\s+') + '\\b');
    if (re.test(s)){ state.scale = k; s = s.replace(re, ' '); changed.push('scale'); break; }
  }

  const rootM = s.match(/\b([a-g])(#|♯|b|♭)?(\d)?(?![a-z0-9])/);
  if (rootM){
    const base = {c:0,d:2,e:4,f:5,g:7,a:9,b:11}[rootM[1]];
    const acc = rootM[2]==='#'||rootM[2]==='♯' ? 1 : (rootM[2]==='b'||rootM[2]==='♭' ? -1 : 0);
    state.rootPc = pcOf(base + acc);
    if (rootM[3]){ const o = +rootM[3]; if (o >= 2 && o <= 5) state.rootOct = o; }
    s = s.replace(rootM[0], ' ');
    changed.push('key');
  }

  const seq = [];
  s.replace(/(\d+)\s*\*\s*(\d+)|(\d+)|\br\b|\brest\b/g, (m, a, mult, b) => {
    if (m === 'r' || m === 'rest'){ seq.push({ d: null, len: state.noteLen }); return ''; }
    const n = +(a !== undefined ? a : b);
    if (n >= 0 && n <= 15){
      const k = mult ? Math.max(1, Math.min(8, +mult)) : 1;
      seq.push({ d: n, len: Math.max(1, Math.min(16, state.noteLen * k)) });
    }
    return '';
  });
  if (seq.length){
    state.sequence = seq;
    selStep = -1;
    changed.push('sequence');
  }

  if (!changed.length){
    notice('Didn\u2019t catch that. Try \u201CD dorian 1 2 3 2 1 at 88bpm\u201D.');
    return;
  }
  hideNotice();
  $('cmd').value = '';
  structuralChange();
}

/* ============================================================
   Persistence and boot
   ============================================================ */
let saveTimer = null;
function save(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const obj = {};
    SAVE_KEYS.forEach(k => obj[k] = state[k]);
    store.saveSetup(obj);
  }, 350);
}

(async function boot(){
  const saved = await store.loadSetup();
  if (saved){
    SAVE_KEYS.forEach(k => { if (saved[k] !== undefined) state[k] = saved[k]; });
    if (state.mode === 'practice') state.mode = 'ladder'; // migrate old saves
    if (saved.noteLen === undefined && saved.ticksPerStep !== undefined) state.noteLen = saved.ticksPerStep;
    state.sequence = normalizeSequence(saved.sequence, state.noteLen);
  }

  buildControls();
  wire();
  refresh();

  $('storenote').textContent = store.backend === 'memory'
    ? 'Storage unavailable — settings won\'t survive a reload.'
    : 'Settings and saved exercises live in this browser only.';

  // settings checkboxes after wire()
  $('sticky').checked = state.sticky;

  audio.setVoice(state.voice);
  audio.setVolume(state.vol);

  try {
    await audio.load();
    primeOnFirstGesture(audio);
  } catch (e) {
    notice('Sound could not load — the audio library is blocked. Everything else works.');
  }
})();
