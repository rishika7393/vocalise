// The two visual pieces both pages need: a piano keyboard and the contour of
// the sequence. Kept dumb on purpose — they take data and paint, nothing else.

import { degToSemi, pcOf, octOf, isBlack, LO, HI } from './theory.js';

export function keyboardWindow(rootMidi, sequence, steps, down, up){
  const notes = [];
  for (let t = down; t <= up; t++){
    notes.push(rootMidi + t);
    sequence.filter(st => st.d !== null).forEach(st => notes.push(rootMidi + t + degToSemi(st.d, steps)));
  }
  if (!notes.length) return [48, 84];
  let lo = Math.max(LO, Math.floor(Math.min(...notes) / 12) * 12);
  let hi = Math.min(HI, Math.ceil((Math.max(...notes) + 1) / 12) * 12 - 1);
  if (hi - lo < 24) hi = Math.min(HI, lo + 24);
  return [lo, hi];
}

export function buildKeyboard(el, [lo, hi]){
  el.innerHTML = '';
  const whites = document.createElement('div');
  whites.className = 'whites';
  const blacks = [];
  let total = 0;
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) total++;
  let wIdx = 0;
  for (let m = lo; m <= hi; m++){
    if (isBlack(m)){ blacks.push([m, wIdx]); continue; }
    const d = document.createElement('div');
    d.className = 'w';
    d.dataset.midi = m;
    if (pcOf(m) === 0){
      const l = document.createElement('span');
      l.className = 'lbl';
      l.textContent = 'C' + octOf(m);
      d.appendChild(l);
    }
    whites.appendChild(d);
    wIdx++;
  }
  el.appendChild(whites);
  const w = 100 / total;
  blacks.forEach(([m, idx]) => {
    const d = document.createElement('div');
    d.className = 'b';
    d.dataset.midi = m;
    d.style.left = (idx * w) + '%';
    d.style.width = (w * 0.6) + '%';
    el.appendChild(d);
  });
}

// marks: array of { midi, cls } — 'on', 'tonic' or 'sung'.
export function paintKeys(el, tonicPc, steps, marks = []){
  const inScale = new Set(steps.map(s => (tonicPc + s) % 12));
  const byMidi = new Map(marks.filter(m => m && m.midi != null).map(m => [m.midi, m.cls]));
  el.querySelectorAll('[data-midi]').forEach(node => {
    const m = +node.dataset.midi;
    const cls = byMidi.get(m);
    node.classList.toggle('inscale', inScale.has(pcOf(m)));
    node.classList.toggle('on', cls === 'on');
    node.classList.toggle('tonic', cls === 'tonic');
    node.classList.toggle('sung', cls === 'sung');
  });
}

// Notes are placed on a real timeline so a mixed rhythm looks like one. Each
// note gets a wide transparent hit circle carrying data-seq.
// opts: { active: seqIndex, results: { [seqIndex]: 'hit'|'near'|'miss' }, pickable: bool }
export function paintContour(svg, sequence, steps, opts = {}){
  const { active = -1, results = {}, pickable = true } = opts;

  let cursor = 0;
  const items = [];
  sequence.forEach((st, i) => {
    const len = Math.max(1, st.len || 2);
    if (st.d !== null) items.push({ i, d: st.d, semi: degToSemi(st.d, steps), start: cursor, len });
    cursor += len;
  });
  if (!items.length){ svg.innerHTML = ''; return; }

  const total = Math.max(1, cursor);
  const vals  = items.map(o => o.semi);
  const min   = Math.min(...vals), max = Math.max(...vals);
  // Enforce a minimum vertical span so a flat sequence (all same pitch) shows
  // as dots in the middle rather than a distracting horizontal line.
  const span  = Math.max(4, max - min);
  const W = 1000, H = 100, padY = 22, padX = 36;
  const inner = W - padX * 2;
  const midY  = H / 2;
  const x  = tick => padX + (tick / total) * inner;
  // Centre the sequence vertically when span is small (all same note etc.)
  const yRange = H - padY * 2;
  const yBase  = max === min ? midY : H - padY;
  const y  = v => max === min ? midY : yBase - ((v - min) / span) * yRange;

  // Curved path through note centres
  const pts = items.map(o => x(o.start + o.len / 2) + ',' + y(o.semi));

  // Build a smooth SVG path with cubic bezier curves between points
  let pathD = '';
  if (pts.length === 1){
    pathD = 'M' + pts[0];
  } else {
    pathD = 'M' + pts[0];
    for (let i = 0; i < pts.length - 1; i++){
      const [x0, y0] = pts[i].split(',').map(Number);
      const [x1, y1] = pts[i + 1].split(',').map(Number);
      const cpx = (x0 + x1) / 2;
      pathD += ' C' + cpx + ',' + y0 + ' ' + cpx + ',' + y1 + ' ' + x1 + ',' + y1;
    }
  }

  let out = '<path class="path" d="' + pathD + '" fill="none"/>';

  // Draw dots on top of the path (z-order: path first, then dots)
  items.forEach(o => {
    const cx  = x(o.start + o.len / 2), cy = y(o.semi);
    const on  = o.i === active;
    const res = results[o.i];
    const done = active >= 0 && o.i < active;
    const cls  = res || (on ? 'on' : done ? 'done' : '');

    out += '<circle class="dot ' + cls + '" cx="' + cx + '" cy="' + cy + '" r="' + (on ? 8 : 5.5) + '"/>';
    out += '<text class="num' + (on ? ' on' : '') + '" x="' + cx + '" y="' + (H - 4) + '">' + o.d + '</text>';
    if (pickable){
      out += '<circle class="hit" cx="' + cx + '" cy="' + cy + '" r="22" data-seq="' + o.i +
             '" tabindex="0" role="button"><title>Jump to degree ' + o.d + '</title></circle>';
    }
  });

  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.innerHTML = out;
}
