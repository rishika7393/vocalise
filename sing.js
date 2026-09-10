import {
  SCALES, SOLFEGE, FLAT_PC, LO, HI,
  degToSemi, pcOf, octOf, nameOf, fullName, useFlats, seqToText,
  nearestDegree, normalizeSequence,
} from './theory.js';
import { keyboardWindow, buildKeyboard, paintKeys, paintContour } from './visual.js';
import { Audio, primeOnFirstGesture } from './audio.js';
import { Runner } from './runner.js';
import { PitchTracker, NoteCapture } from './pitch.js';
import * as store from './store.js';

const $ = id => document.getElementById(id);

const HIT_CENTS  = 25;
const NEAR_CENTS = 50;
const MAX_HIST   = 20;  // reps to keep in the history chart

const setup = {
  rootPc: 0, rootOct: 4, scale: 'major',
  sequence: normalizeSequence([1, 2, 3, 2, 1], 2),
  bpm: 84, noteLen: 2,
  up: 12, down: -5,
};
let task      = 'back';
let passMode  = 'learn';
let recording = false;

const audio   = new Audio();
const runner  = new Runner(audio);
let tracker   = null;
let capture   = new NoteCapture();
let captured  = [];
let capTonicMidi = null;
let rafId     = null;

let bucket    = null;   // note currently being sung against
let results   = {};     // seqIndex → 'hit'|'near'|'miss'|'none'
let cells     = [];     // { deg, cents, res }
let lastSung  = null;
let repHistory = [];    // array of { pass, cells[] } — up to MAX_HIST complete passes

const rootMidi  = () => (setup.rootOct + 1) * 12 + setup.rootPc;
const flat      = () => useFlats(setup.rootPc);
const steps     = () => SCALES[setup.scale].steps;
const capSteps  = () => SCALES[$('capscale').value]?.steps || steps();

/* ============================================================
   Painting
   ============================================================ */
function paintIdle(){
  $('pitch').className = 'pitch idle';
  $('pitch').innerHTML = nameOf(rootMidi(), flat()) + '<sup>' + octOf(rootMidi()) + '</sup>';
  $('gloss').innerHTML = task === 'capture'
    ? '<span>sing anything</span>'
    : '<span>' + SCALES[setup.scale].label.toLowerCase() + '</span><span>' + seqToText(setup.sequence) + '</span>';
}

function rebuildKb(){
  buildKeyboard($('kb'), keyboardWindow(rootMidi(), setup.sequence, steps(),
    passMode === 'practice' ? setup.down : 0,
    passMode === 'practice' ? setup.up   : 0));
  paintKeys($('kb'), pcOf(rootMidi()), steps(), []);
}

function paintKb(marks){
  paintKeys($('kb'), pcOf(rootMidi() + (runner.playing ? runner.transpose : 0)), steps(), marks);
}

function paintTuner(cents, active){
  const t = $('tuner'), n = $('needle');
  t.classList.toggle('off', !active);
  if (!active){ n.style.left = '50%'; n.className = 'needle'; return; }
  n.style.left = (50 + Math.max(-50, Math.min(50, cents))) + '%';
  const a = Math.abs(cents);
  n.className = 'needle' + (a <= HIT_CENTS ? ' hit' : a <= NEAR_CENTS ? ' near' : '');
}

function paintStrip(){
  $('taskseg').querySelectorAll('button').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.task === task)));
  $('passseg').querySelectorAll('button').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.mode === passMode)));
  $('bpmread').innerHTML = setup.bpm + ' <span>bpm</span>';
  const back = task === 'back';
  $('tempowrap').style.display = back ? '' : 'none';
  $('passseg').style.display   = back ? '' : 'none';
  $('nowset').innerHTML = '<b>' + nameOf(rootMidi(), flat()) + octOf(rootMidi()) + ' ' +
    SCALES[setup.scale].label.toLowerCase() + '</b> · ' + seqToText(setup.sequence);
  $('exsummary').textContent = fullName(rootMidi(), flat()) + ' ' +
    SCALES[setup.scale].label.toLowerCase() + ' · ' + seqToText(setup.sequence) + ' · ♩=' + setup.bpm;
}

function paintButtons(){
  const active = runner.playing || recording;
  $('go').hidden   = !tracker || active;
  $('stop').hidden = !active;
  $('go').textContent = task === 'back' ? 'Start' : 'Record';
}

/* ============================================================
   Per-note score painting
   ============================================================ */
function paintScore(){
  $('score').innerHTML = cells.map(c => {
    const lbl = c.res === 'none' ? 'no sound'
      : (c.cents > 0 ? '+' : '') + Math.round(c.cents) + '¢';
    return '<div class="cell ' + c.res + '"><b>' + c.deg + '</b>' + lbl + '</div>';
  }).join('');
}

function paintSummary(){
  const scored = cells.filter(c => c.res !== 'none');
  if (!scored.length){ $('summary').textContent = ''; return; }
  const hits = scored.filter(c => c.res === 'hit').length;
  const avg  = scored.reduce((a, c) => a + Math.abs(c.cents), 0) / scored.length;
  const drift = scored.reduce((a, c) => a + c.cents, 0) / scored.length;
  const lean = Math.abs(drift) < 8 ? 'centred'
    : drift > 0 ? 'leaning sharp by ' + Math.round(drift) + '¢'
    : 'leaning flat by '  + Math.round(-drift) + '¢';
  $('summary').innerHTML = '<b>' + hits + '/' + scored.length + '</b> on pitch · ' +
    Math.round(avg) + '¢ avg · ' + lean;
}

/* ============================================================
   Rep history chart
   ============================================================ */
function recordRep(){
  if (!cells.length) return;
  const entry = { cells: cells.map(c => ({ ...c })), pass: runner.transpose };
  repHistory.push(entry);
  if (repHistory.length > MAX_HIST) repHistory.shift();
  paintHistory();
}

function paintHistory(){
  if (!repHistory.length){ $('histwrap').style.display = 'none'; return; }
  $('histwrap').style.display = '';

  const svg = $('histsvg');
  // Each rep is a column; each note in the rep is a cell within that column.
  const R = repHistory.length;
  const N = repHistory[0].cells.length;
  const cellW = 28, cellH = 14, gapX = 4, gapY = 2;
  const colW = N * (cellW + gapY);
  const W = R * (colW + gapX), H = 80;
  svg.setAttribute('width', W); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

  let out = '';
  repHistory.forEach((rep, ri) => {
    const x0 = ri * (colW + gapX);
    // label: semitone offset
    const sign = rep.pass > 0 ? '+' : '';
    out += '<text x="' + (x0 + colW / 2) + '" y="10" text-anchor="middle" font-size="7" fill="var(--dim)" font-family="var(--sans)">' +
      (sign + rep.pass) + '</text>';
    rep.cells.forEach((c, ni) => {
      const x = x0 + ni * (cellW + gapY);
      const y = 14;
      const col = c.res === 'hit' ? 'var(--good)' : c.res === 'near' ? 'var(--brass)'
        : c.res === 'miss' ? 'var(--rose)' : 'var(--raise)';
      out += '<rect x="' + x + '" y="' + y + '" width="' + cellW + '" height="' + (H - 20) +
        '" rx="2" fill="' + col + '" fill-opacity="' + (c.res === 'none' ? '.2' : '.85') + '">';
      out += '<title>Rep ' + (sign + rep.pass) + ' · deg ' + c.deg + ' · ' +
        (c.res === 'none' ? 'no sound' : (c.cents > 0 ? '+' : '') + Math.round(c.cents) + '¢') + '</title></rect>';
      // degree label inside cell
      out += '<text x="' + (x + cellW / 2) + '" y="' + (y + (H - 20) / 2 + 3) + '" text-anchor="middle" font-size="8" fill="var(--ground)" font-weight="600" font-family="var(--sans)">' +
        c.deg + '</text>';
      // cents offset bar — maps ±50¢ to cell width
      if (c.res !== 'none'){
        const barFrac = Math.max(-1, Math.min(1, c.cents / 50));
        const midX = x + cellW / 2;
        const barX = barFrac >= 0 ? midX : midX + barFrac * (cellW * 0.4);
        const barW = Math.abs(barFrac) * cellW * 0.4;
        out += '<rect x="' + barX + '" y="' + (y + H - 30) + '" width="' + Math.max(1.5, barW) +
          '" height="3" rx="1" fill="var(--ground)" opacity=".5"/>';
      }
    });
  });
  svg.innerHTML = out;
}

/* ============================================================
   Scoring one note
   ============================================================ */
function closeBucket(){
  if (!bucket) return;
  const b = bucket; bucket = null;
  const from = Math.floor(b.samples.length * 0.35);
  const to   = Math.ceil(b.samples.length * 0.9);
  const mid  = b.samples.slice(from, to);
  if (mid.length < 3){
    results[b.seq] = 'none';
    cells.push({ deg: b.deg, cents: 0, res: 'none' });
  } else {
    const sorted = [...mid].sort((x, y) => x - y);
    const med = sorted[Math.floor(sorted.length / 2)];
    let d = med - b.target; d -= 12 * Math.round(d / 12);
    const cents = d * 100;
    const res = Math.abs(cents) <= HIT_CENTS ? 'hit' : Math.abs(cents) <= NEAR_CENTS ? 'near' : 'miss';
    results[b.seq] = res;
    cells.push({ deg: b.deg, cents, res });
  }
  paintContour($('contour'), setup.sequence, steps(), { results });
  paintScore();
  paintSummary();
}

/* ============================================================
   Sing-back pass
   ============================================================ */
function onStep(s){
  closeBucket();
  if (s.countBeat){
    $('pitch').className = 'pitch count'; $('pitch').textContent = s.countBeat;
    $('gloss').innerHTML = '<span>get ready</span>'; return;
  }
  if (s.kind === 'root'){
    $('pitch').className = 'pitch tonic';
    $('pitch').innerHTML = nameOf(s.midi, flat()) + '<sup>' + octOf(s.midi) + '</sup>';
    $('gloss').innerHTML = '<span>listen — starting note</span>';
    paintKb([{ midi: s.midi, cls: 'tonic' }]); return;
  }
  if (s.kind === 'hold') return;
  if (s.kind === 'rest'){ $('pitch').className = 'pitch idle'; $('gloss').innerHTML = ''; return; }

  bucket = { seq: s.seq, deg: s.deg, target: s.midi, samples: [] };
  $('pitch').className = 'pitch';
  $('pitch').innerHTML = nameOf(s.midi, flat()) + '<sup>' + octOf(s.midi) + '</sup>';
  const semi = pcOf(s.midi - (rootMidi() + s.transpose));
  $('gloss').innerHTML = '<span>degree <b>' + s.deg + '</b></span><span><b>' + SOLFEGE[semi] + '</b></span>';
  paintContour($('contour'), setup.sequence, steps(), { active: s.seq, results });
  paintKb([{ midi: s.midi, cls: 'on' }, lastSung != null ? { midi: lastSung, cls: 'sung' } : null].filter(Boolean));
}

function startRun(){
  results = {}; cells = []; bucket = null;
  paintScore(); paintSummary();
  paintContour($('contour'), setup.sequence, steps(), {});
  const ok = runner.start({
    rootMidi: rootMidi(), scaleSteps: steps(), sequence: setup.sequence,
    mode: passMode, bpm: setup.bpm,
    up: setup.up, down: setup.down,
    playRoot: true, stopEnd: true, countIn: true, metro: true, drone: false,
    soundNotes: false, soundRoot: true,
  }, {
    onStep,
    onRep: () => {
      recordRep();
      results = {}; cells = [];
      paintScore(); paintSummary();
    },
    onJump: i => {
      bucket = null;
      Object.keys(results).forEach(k => { if (+k >= i) delete results[+k]; });
      cells = cells.slice(0, Object.keys(results).length);
      paintScore(); paintSummary();
      paintContour($('contour'), setup.sequence, steps(), { active: i, results });
    },
    onStop: () => { closeBucket(); recordRep(); paintButtons(); paintIdle(); },
    onEnd: paintButtons,
    onError: notice,
  });
  if (ok) paintButtons();
}

/* ============================================================
   Capture run
   ============================================================ */
function commitNote(n){
  captured.push(n.midi);
  if (capTonicMidi == null && $('captonic').value === 'first') capTonicMidi = n.midi;
  paintCaptured();
}

function capturedDegrees(){
  const tonic = $('captonic').value === 'first'
    ? (capTonicMidi != null ? capTonicMidi : rootMidi()) : rootMidi();
  return captured.map(m => nearestDegree(m, tonic, capSteps()).deg);
}

function paintCaptured(){
  $('capbox').innerHTML = captured.length
    ? captured.map((m, i) =>
        '<button class="step" data-i="' + i + '">' + fullName(m, flat()) + '</button>').join('')
    : '<span class="empty">Nothing captured yet.</span>';
  const degs = capturedDegrees();
  $('capdegrees').textContent = degs.length ? 'Scale degrees: ' + degs.join(' ') : '';
  $('capbox').onclick = e => {
    const b = e.target.closest('[data-i]'); if (!b) return;
    captured.splice(+b.dataset.i, 1); paintCaptured();
  };
}

/* ============================================================
   Mic loop
   ============================================================ */
function loop(){
  rafId = requestAnimationFrame(loop);
  if (!tracker?.running) return;
  const r = tracker.read();

  if (task === 'capture'){
    if (recording){
      const done = capture.feed(r, performance.now());
      if (done) commitNote(done);
    }
    if (r){
      lastSung = r.midi;
      $('pitch').className = 'pitch';
      $('pitch').innerHTML = nameOf(r.midi, flat()) + '<sup>' + octOf(r.midi) + '</sup>';
      $('gloss').innerHTML = '<span>' + (r.cents > 0 ? '+' : '') + Math.round(r.cents) + ' cents</span>';
      paintTuner(r.cents, true);
      $('centsread').innerHTML = '<b>' + Math.round(r.hz) + ' Hz</b>';
      paintKb([{ midi: r.midi, cls: 'sung' }]);
    } else {
      paintTuner(0, false);
      $('centsread').textContent = 'Listening…';
    }
    return;
  }

  if (!r){ paintTuner(0, false); $('centsread').textContent = runner.playing ? 'Listening…' : 'Ready.'; return; }
  lastSung = r.midi;
  if (bucket){
    bucket.samples.push(r.midiFloat);
    let d = r.midiFloat - bucket.target; d -= 12 * Math.round(d / 12);
    const cents = d * 100;
    paintTuner(cents, true);
    $('centsread').innerHTML = 'You are on <b>' + fullName(r.midi, flat()) + '</b> · ' +
      (cents > 0 ? '+' : '') + Math.round(cents) + '¢';
  } else {
    paintTuner(0, false);
    $('centsread').innerHTML = 'You are on <b>' + fullName(r.midi, flat()) + '</b>';
  }
}

/* ============================================================
   Mic enable
   ============================================================ */
async function enableMic(){
  try {
    tracker = new PitchTracker({ minHz: +$('lowhz').value });
    await tracker.start();
    await audio.load().catch(() => {});
    await audio.prime().catch(() => {});
    $('mic').hidden = true;
    $('micnotice').hidden = true;
    $('go').hidden = false;
    $('centsread').textContent = 'Ready.';
    hideNotice();
    loop();
  } catch (e) {
    tracker = null;
    notice(e?.name === 'NotAllowedError'
      ? 'Microphone access declined. Allow it in your browser\u2019s site settings and reload.'
      : 'No microphone found. Check that one is connected and the page is on https or localhost.');
  }
}

function go(){
  hideNotice();
  if (task === 'back'){ startRun(); return; }
  capture.reset();
  captured = []; capTonicMidi = $('captonic').value === 'setup' ? rootMidi() : null;
  recording = true;
  paintCaptured(); paintButtons();
  $('centsread').textContent = 'Recording — sing your phrase.';
}

function stop(){
  if (task === 'back'){ runner.stop(); return; }
  recording = false;
  const last = capture.flush();
  if (last) commitNote(last);
  paintButtons(); paintIdle();
  $('centsread').textContent = captured.length ? 'Captured ' + captured.length + ' notes.' : 'Nothing heard.';
}

function notice(msg){ const n = $('notice'); n.textContent = msg; n.hidden = false; }
function hideNotice(){ $('notice').hidden = true; }

/* ============================================================
   Wiring
   ============================================================ */
function wire(){
  $('mic').onclick = enableMic;
  $('go').onclick = go;
  $('stop').onclick = stop;

  $('taskseg').onclick = e => {
    const b = e.target.closest('[data-task]'); if (!b) return;
    if (runner.playing) runner.stop();
    recording = false; task = b.dataset.task;
    // Sync tab selection to task
    document.querySelectorAll('.tabs button').forEach(x =>
      x.setAttribute('aria-selected', String(x.dataset.pane === (task === 'capture' ? 'capture' : 'what'))));
    document.querySelectorAll('.pane').forEach(p =>
      p.hidden = p.id !== 'pane-' + (task === 'capture' ? 'capture' : 'what'));
    paintStrip(); paintButtons(); paintIdle();
    $('score').innerHTML = ''; $('summary').textContent = '';
    $('histwrap').style.display = 'none'; repHistory = [];
    paintContour($('contour'), setup.sequence, steps(), {});
  };

  $('passseg').onclick = e => {
    const b = e.target.closest('[data-mode]'); if (!b) return;
    if (runner.playing) runner.stop();
    passMode = b.dataset.mode; paintStrip(); rebuildKb();
  };

  const setBpm = v => {
    setup.bpm = Math.max(40, Math.min(200, Math.round(v)));
    runner.setTempo(setup.bpm); paintStrip();
  };
  $('bpmup').onclick   = () => setBpm(setup.bpm + 1);
  $('bpmdown').onclick = () => setBpm(setup.bpm - 1);

  $('lowhz').onchange = () => { if (tracker) tracker.minHz = +$('lowhz').value; };

  // contour tapping
  const pick = async i => {
    if (runner.playing){ runner.jumpTo(i); return; }
    const st = setup.sequence[i];
    if (!st || st.d === null) return;
    await audio.prime().catch(() => {});
    audio.note(rootMidi() + degToSemi(st.d, steps()), 0.55);
  };
  $('contour').addEventListener('click', e => { const h = e.target.closest('[data-seq]'); if (h) pick(+h.dataset.seq); });
  $('contour').addEventListener('keydown', e => {
    const h = e.target.closest && e.target.closest('[data-seq]'); if (!h) return;
    if (e.key === 'Enter' || e.code === 'Space'){ e.preventDefault(); pick(+h.dataset.seq); }
  });

  // tabs
  document.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-pane]'); if (!b) return;
    document.querySelectorAll('.tabs button').forEach(x =>
      x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.pane').forEach(p => p.hidden = p.id !== 'pane-' + b.dataset.pane);
  });

  $('captonic').onchange = paintCaptured;
  $('capscale').onchange = paintCaptured;
  $('capundo').onclick = () => { captured.pop(); paintCaptured(); };
  $('capclear').onclick = () => { captured = []; capTonicMidi = null; paintCaptured(); };
  $('capuse').onclick = async () => {
    const degs = capturedDegrees();
    if (!degs.length){ notice('Nothing captured yet.'); return; }
    const tonic = $('captonic').value === 'first' && capTonicMidi != null ? capTonicMidi : rootMidi();
    const prev = (await store.loadSetup()) || {};
    const next = {
      ...prev,
      rootPc: pcOf(tonic), rootOct: octOf(tonic),
      scale: $('capscale').value,
      sequence: degs.map(d => ({ d, len: setup.noteLen || 2 })),
    };
    await store.saveSetup(next);
    Object.assign(setup, { rootPc: next.rootPc, rootOct: next.rootOct, scale: next.scale, sequence: next.sequence });
    paintStrip(); rebuildKb(); paintIdle();
    paintContour($('contour'), setup.sequence, steps(), {});
    $('capnote').innerHTML = 'Saved. Open <a href="index.html">Practice</a> to run it.';
  };

  document.addEventListener('keydown', e => {
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'BUTTON' || t === 'TEXTAREA') return;
    if (e.target.closest && e.target.closest('[data-seq]')) return;
    if (e.code === 'Space'){
      e.preventDefault();
      if (!tracker) return enableMic();
      (runner.playing || recording) ? stop() : go();
    }
  });
}

/* ============================================================
   Boot
   ============================================================ */
(async function boot(){
  const saved = await store.loadSetup();
  if (saved){
    Object.keys(setup).forEach(k => { if (saved[k] !== undefined) setup[k] = saved[k]; });
    if (saved.noteLen !== undefined) setup.noteLen = saved.noteLen;
    else if (saved.ticksPerStep !== undefined) setup.noteLen = saved.ticksPerStep;
    setup.sequence = normalizeSequence(saved.sequence, setup.noteLen || 2);
  }

  $('capscale').innerHTML = Object.entries(SCALES).map(([k, v]) =>
    '<option value="' + k + '"' + (k === setup.scale ? ' selected' : '') + '>' + v.label + '</option>').join('');

  const lib = await store.listExercises();
  $('pick').innerHTML = '<option value="">Current (from Practice page)</option>' +
    lib.map(e => '<option value="' + e.id + '">' + e.name.replace(/</g, '&lt;') + '</option>').join('');
  $('pick').onchange = async ev => {
    if (!ev.target.value) return;
    const l = await store.listExercises();
    const ex = l.find(x => x.id === ev.target.value);
    if (!ex) return;
    Object.assign(setup, {
      rootPc: ex.rootPc, rootOct: ex.rootOct, scale: ex.scale,
      bpm: ex.bpm,
      noteLen: ex.noteLen !== undefined ? ex.noteLen : (ex.ticksPerStep || 2),
      up: ex.up, down: ex.down,
    });
    setup.sequence = normalizeSequence(ex.sequence, setup.noteLen);
    $('capscale').value = setup.scale;
    if (runner.playing) runner.stop();
    paintStrip(); rebuildKb(); paintIdle();
    paintContour($('contour'), setup.sequence, steps(), {});
    repHistory = []; paintHistory();
  };

  wire();
  paintStrip(); rebuildKb(); paintIdle();
  paintContour($('contour'), setup.sequence, steps(), {});
  paintCaptured();

  try {
    await audio.load();
    primeOnFirstGesture(audio);
  } catch (e) {}
})();
