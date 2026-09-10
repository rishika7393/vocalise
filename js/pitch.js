// Monophonic pitch detection, no library. YIN's cumulative mean normalised
// difference function, run at half rate to find the period cheaply, then
// refined at full rate around that guess so the cents reading stays honest.

import { hzToMidi, midiToHz } from './theory.js';

function nativeContext(){
  try {
    if (window.Tone && Tone.context && Tone.context.rawContext) return Tone.context.rawContext;
  } catch (e) { /* Tone not loaded yet */ }
  return new (window.AudioContext || window.webkitAudioContext)();
}

function cmndf(buf, minLag, maxLag){
  const W = buf.length - maxLag;
  const d = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++){
    let sum = 0;
    for (let i = 0; i < W; i++){ const x = buf[i] - buf[i + lag]; sum += x * x; }
    d[lag] = sum;
  }
  const c = new Float32Array(maxLag + 1).fill(1);
  let run = 0;
  for (let lag = minLag; lag <= maxLag; lag++){
    run += d[lag];
    c[lag] = run === 0 ? 1 : d[lag] * (lag - minLag + 1) / run;
  }
  return c;
}

// Full-rate search in a narrow window, with parabolic interpolation for the
// sub-sample position of the minimum.
function refineLag(buf, centre, halfWidth){
  const lo = Math.max(2, centre - halfWidth);
  const hi = Math.min(buf.length - 2, centre + halfWidth);
  if (hi <= lo) return centre;
  const W = buf.length - hi;
  const vals = new Float32Array(hi - lo + 1);
  let best = lo, bestV = Infinity;
  for (let lag = lo; lag <= hi; lag++){
    let sum = 0;
    for (let i = 0; i < W; i++){ const x = buf[i] - buf[i + lag]; sum += x * x; }
    vals[lag - lo] = sum;
    if (sum < bestV){ bestV = sum; best = lag; }
  }
  if (best > lo && best < hi){
    const s0 = vals[best - lo - 1], s1 = vals[best - lo], s2 = vals[best - lo + 1];
    const den = 2 * (s0 - 2 * s1 + s2);
    if (den > 0) return best + (s0 - s2) / den;
  }
  return best;
}

export function detect(buf, sampleRate, minHz = 70, maxHz = 1100){
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.006) return null;              // room tone, not a voice

  // Half-rate copy for the coarse search.
  const half = new Float32Array(n >> 1);
  for (let i = 0; i < half.length; i++) half[i] = (buf[2 * i] + buf[2 * i + 1]) * 0.5;

  const sr2 = sampleRate / 2;
  const maxLag = Math.min(Math.floor(sr2 / minHz), (half.length >> 1) - 1);
  const minLag = Math.max(2, Math.floor(sr2 / maxHz));
  if (maxLag <= minLag + 2) return null;

  const c = cmndf(half, minLag, maxLag);

  let tau = -1;
  for (let lag = minLag + 1; lag < maxLag; lag++){
    if (c[lag] < 0.15){
      while (lag + 1 <= maxLag && c[lag + 1] < c[lag]) lag++;
      tau = lag; break;
    }
  }
  if (tau < 0){
    let best = minLag + 1;
    for (let lag = minLag + 1; lag <= maxLag; lag++) if (c[lag] < c[best]) best = lag;
    if (c[best] > 0.4) return null;          // nothing periodic enough to trust
    tau = best;
  }

  const clarity = Math.max(0, Math.min(1, 1 - c[tau]));
  const exact = refineLag(buf, tau * 2, 4);
  const hz = sampleRate / exact;
  if (!isFinite(hz) || hz < minHz || hz > maxHz) return null;

  const midiFloat = hzToMidi(hz);
  const midi = Math.round(midiFloat);
  return { hz, midiFloat, midi, cents: (midiFloat - midi) * 100, clarity, rms };
}

export class PitchTracker {
  constructor(opts = {}){
    this.minHz = opts.minHz || 70;
    this.maxHz = opts.maxHz || 1100;
    this.running = false;
    this.ctx = null; this.stream = null; this.analyser = null; this.buf = null;
    this.recent = [];
  }

  async start(){
    if (this.running) return;
    // Every one of these processors fights pitch detection, so turn them off.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = nativeContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    src.connect(this.analyser);            // deliberately not connected to output
    this.buf = new Float32Array(this.analyser.fftSize);
    this.running = true;
  }

  stop(){
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null; this.analyser = null; this.recent = [];
  }

  // Call from a rAF loop. Median of the last three readings smooths the jitter
  // without adding noticeable lag.
  read(){
    if (!this.running || !this.analyser) return null;
    this.analyser.getFloatTimeDomainData(this.buf);
    const r = detect(this.buf, this.ctx.sampleRate, this.minHz, this.maxHz);
    if (!r){ this.recent = []; return null; }
    this.recent.push(r.midiFloat);
    if (this.recent.length > 3) this.recent.shift();
    const sorted = [...this.recent].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const midi = Math.round(med);
    return { ...r, midiFloat: med, midi, hz: midiToHz(med), cents: (med - midi) * 100 };
  }
}

// Turns a stream of readings into discrete notes, so you can build an exercise
// by singing it. Leave a small gap between notes — two identical pitches sung
// legato read as one held note.
export class NoteCapture {
  constructor(opts = {}){
    this.holdMs = opts.holdMs || 130;
    this.jumpCents = opts.jumpCents || 140;
    this.silenceMs = opts.silenceMs || 70;
    this.cand = null;
    this.silentSince = null;
    this.notes = [];
  }

  reset(){ this.cand = null; this.silentSince = null; this.notes = []; }

  _commit(now){
    const c = this.cand;
    this.cand = null;
    if (!c) return null;
    if (now - c.start < this.holdMs) return null;
    const s = [...c.samples].sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)];
    const note = { midi: Math.round(med), midiFloat: med, ms: now - c.start };
    this.notes.push(note);
    return note;
  }

  feed(reading, now){
    if (!reading || reading.clarity < 0.55){
      if (this.silentSince == null) this.silentSince = now;
      if (now - this.silentSince > this.silenceMs) return this._commit(now);
      return null;
    }
    this.silentSince = null;
    if (!this.cand){
      this.cand = { start: now, samples: [reading.midiFloat] };
      return null;
    }
    const ref = this.cand.samples[this.cand.samples.length - 1];
    if (Math.abs(reading.midiFloat - ref) * 100 > this.jumpCents){
      const done = this._commit(now);
      this.cand = { start: now, samples: [reading.midiFloat] };
      return done;
    }
    this.cand.samples.push(reading.midiFloat);
    return null;
  }

  flush(now = performance.now()){ return this._commit(now); }
}
