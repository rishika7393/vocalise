// Drives the exercise on a sixteenth-note grid. Each step carries its own
// length in ticks so a pass can mix half-beats, whole-beats and dotted notes.
// In sticky mode the runner parks on a note and waits for the user to sing it
// in tune before advancing; tempo is ignored for that step.

import { degToSemi, LO, HI } from './theory.js';

const DEFAULTS = {
  mode: 'ladder', bpm: 84,
  up: 12, down: -5,
  playRoot: true, stopEnd: false, countIn: false, metro: false, drone: false,
  soundNotes: true, soundRoot: true,
  rootTicks: 4, gapTicks: 4,
  sticky: false,
};

const HIT_CENTS = 40;   // within 40¢ counts as in-tune for sticky mode

export class Runner {
  constructor(audio){
    this.audio = audio;
    this.playing = false;
    this.ending  = false;
    this.transpose = 0;
    this.dir = 1;
    this.cfg = null;
    this.h = {};
    this._reset();
  }

  _reset(){
    this.steps = []; this.ptr = 0; this.wait = 0; this.beat = 0;
    this.countBeats = 0; this.pendingTurn = false;
    this._stickyTarget = null;
    this._stickyAnalyser = null;
    this._stickyBuf = null;
    this._stickySR = null;
    this._stickyRaf = null;
  }

  /* ---------- range checks ---------- */
  span(t){
    const { rootMidi, scaleSteps, sequence, playRoot } = this.cfg;
    const notes = sequence.filter(s => s.d !== null)
      .map(s => rootMidi + t + degToSemi(s.d, scaleSteps));
    if (playRoot) notes.push(rootMidi + t);
    return notes.length ? [Math.min(...notes), Math.max(...notes)] : null;
  }
  fits(t){ const s = this.span(t); return !!s && s[0] >= LO && s[1] <= HI; }

  /* ---------- build one pass ---------- */
  buildRep(t){
    const c = this.cfg, rm = c.rootMidi + t, out = [];
    if (c.playRoot) out.push({ midi: rm, kind: 'root', ticks: c.rootTicks });
    c.sequence.forEach((s, i) => {
      const ticks = Math.max(1, s.len || 2);
      if (s.d === null) out.push({ kind: 'rest', ticks, seq: i });
      else out.push({ midi: rm + degToSemi(s.d, c.scaleSteps), kind: 'note', deg: s.d, seq: i, ticks });
    });
    out.push({ kind: 'rest', tail: true, ticks: c.gapTicks });
    return out;
  }

  buildCountIn(){
    const out = [];
    for (let b = 0; b < 4; b++) out.push({ kind: 'rest', ticks: 4, countBeat: 4 - b });
    return out;
  }

  /* ---------- start / stop ---------- */
  start(cfg, handlers = {}){
    this.cfg = { ...DEFAULTS, ...cfg };
    this.h = handlers;

    if (!this.cfg.sequence.some(s => s.d !== null)){
      this.h.onError && this.h.onError('Add at least one degree to the sequence first.');
      return false;
    }
    if (!this.fits(0)){
      this.h.onError && this.h.onError('That sequence runs off the keyboard from here. Move the starting note or shorten it.');
      return false;
    }

    Tone.Transport.stop(); Tone.Transport.cancel(); Tone.Transport.position = 0;
    Tone.Transport.bpm.value = this.cfg.bpm;

    this._reset();
    this.playing = true; this.ending = false;
    this.transpose = 0; this.dir = 1;
    this.countBeats = this.cfg.countIn ? 4 : 0;

    this.steps = this.buildRep(0);
    if (this.cfg.countIn) this.steps = this.buildCountIn().concat(this.steps);

    if (this.cfg.drone) this.audio.drone(true, this.cfg.rootMidi);

    Tone.Transport.scheduleRepeat(t => this._grid(t), '16n');
    Tone.Transport.scheduleRepeat(t => this._beat(t), '4n');
    Tone.Transport.start('+0.02');

    // Start the sticky mic loop now if needed
    if (this.cfg.sticky) this._stickyStart().catch(() => {
      // mic unavailable — fall back to timed
      this.cfg.sticky = false;
    });

    return true;
  }

  stop(){
    this.playing = false; this.ending = false;
    this._stickyStop();
    try { Tone.Transport.stop(); Tone.Transport.cancel(); Tone.Transport.position = 0; }
    catch (e) {}
    this.audio.releaseAll();
    this.audio.drone(false);
    this._reset();
    this.transpose = 0; this.dir = 1;
    this.h.onStop && this.h.onStop();
  }

  turn(){ if (this.playing) this.pendingTurn = true; }

  setTempo(bpm){
    if (this.cfg) this.cfg.bpm = bpm;
    if (this.playing) Tone.Transport.bpm.rampTo(bpm, 0.1);
  }

  jumpTo(seq){
    if (!this.playing) return false;
    const at = this.steps.findIndex(s => s.seq === seq);
    if (at < 0) return false;
    this.ptr = at; this.wait = 0;
    this._stickyTarget = null;
    this.h.onJump && this.h.onJump(seq);
    return true;
  }

  /* ---------- sticky mic ---------- */
  async _stickyStart(){
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    // Reuse Tone's context if available so we don't fight it.
    let ctx;
    try { ctx = Tone.context.rawContext; } catch (e) { ctx = new AudioContext(); }
    if (ctx.state === 'suspended') await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    this._stickyAnalyser = analyser;
    this._stickyBuf = new Float32Array(analyser.fftSize);
    this._stickySR = ctx.sampleRate;
    this._stickyStream = stream;
  }

  _stickyStop(){
    if (this._stickyStream) this._stickyStream.getTracks().forEach(t => t.stop());
    this._stickyStream = null;
    this._stickyAnalyser = null;
    this._stickyTarget = null;
  }

  // Returns cents deviation from target, or null if no clear pitch.
  _readPitch(){
    if (!this._stickyAnalyser) return null;
    this._stickyAnalyser.getFloatTimeDomainData(this._stickyBuf);
    const buf = this._stickyBuf, SR = this._stickySR;
    // Quick RMS gate
    let rms = 0; for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    if (Math.sqrt(rms / buf.length) < 0.007) return null;
    // CMNDF
    const N = buf.length, minL = Math.floor(SR / 900), maxL = Math.min(Math.floor(SR / 70), N / 2 - 1);
    const d = new Float32Array(maxL + 1); let run = 0;
    for (let lag = minL; lag <= maxL; lag++){
      let sum = 0; const W = N - lag;
      for (let i = 0; i < W; i++){ const x = buf[i] - buf[i + lag]; sum += x * x; }
      run += sum;
      d[lag] = run === 0 ? 1 : sum * (lag - minL + 1) / run;
    }
    let tau = -1;
    for (let lag = minL + 1; lag < maxL; lag++){
      if (d[lag] < 0.15){ while (lag + 1 <= maxL && d[lag + 1] < d[lag]) lag++; tau = lag; break; }
    }
    if (tau < 0){
      let best = minL + 1;
      for (let lag = minL + 1; lag <= maxL; lag++) if (d[lag] < d[best]) best = lag;
      if (d[best] > 0.4) return null;
      tau = best;
    }
    const hz = SR / tau;
    const midiF = 69 + 12 * Math.log2(hz / 440);
    let diff = midiF - this._stickyTarget;
    diff -= 12 * Math.round(diff / 12);  // fold octaves
    return diff * 100;
  }

  /* ---------- ticking ---------- */
  _grid(time){
    if (this.wait > 0){ this.wait--; return; }
    // In sticky mode, if we're parked on a note, check the mic instead of advancing.
    if (this._stickyTarget !== null){
      const cents = this._readPitch();
      const snap = { _stickyCents: cents };
      Tone.Draw.schedule(() => this.h.onStickyRead && this.h.onStickyRead(cents), time);
      if (cents !== null && Math.abs(cents) <= HIT_CENTS){
        // Sung in tune — clear target and advance
        this._stickyTarget = null;
        this.ptr++;
        if (this.ptr >= this.steps.length) this._nextRep(time);
      }
      return;
    }
    this._step(time);
  }

  _beat(time){
    const counting = this.countBeats > 0;
    if (counting) this.countBeats--;
    if (this.cfg.metro || counting) this.audio.click(this.beat % 4 === 0, time);
    this.beat++;
  }

  _step(time){
    if (this.ending) return;
    const s = this.steps[this.ptr];
    if (!s){ this._nextRep(time); return; }

    this.wait = Math.max(1, s.ticks) - 1;

    if (s.kind === 'note' && this.cfg.soundNotes) this._sound(s, time, 0.82);
    if (s.kind === 'root' && this.cfg.soundRoot)  this._sound(s, time, 0.95);

    const snap = { ...s, ptr: this.ptr, transpose: this.transpose, dir: this.dir };
    Tone.Draw.schedule(() => this.h.onStep && this.h.onStep(snap), time);

    // Sticky: park here and wait for the pitch.
    if (this.cfg.sticky && s.kind === 'note' && this._stickyAnalyser){
      this._stickyTarget = s.midi;
      // Don't advance ptr yet — _grid will do it when the note is sung.
      return;
    }

    this.ptr++;
    if (this.ptr >= this.steps.length) this._nextRep(time);
  }

  _sound(s, time, factor){
    const secs = Tone.Time('16n').toSeconds() * s.ticks;
    this.audio.note(s.midi, Math.max(0.05, secs * factor), time);
  }

  _end(time){
    if (this.ending) return;
    this.ending = true;
    Tone.Draw.schedule(() => { this.stop(); this.h.onEnd && this.h.onEnd(); }, time + 0.06);
  }

  _nextRep(time){
    if (this.cfg.mode === 'learn'){ this._end(time); return; }

    // Loop: replay the same transposition forever (until stopped manually).
    if (this.cfg.mode === 'loop'){
      this.steps = this.buildRep(this.transpose);
      this.ptr = 0;
      Tone.Draw.schedule(() => this.h.onRep && this.h.onRep({ transpose: this.transpose, dir: this.dir }), time);
      return;
    }

    let dir = this.dir;
    if (this.pendingTurn){ dir = -dir; this.pendingTurn = false; }
    let t = this.transpose + dir;

    const beyond = (dir > 0 && t > this.cfg.up) || (dir < 0 && t < this.cfg.down);
    if (beyond || !this.fits(t)){
      if (dir < 0 && this.cfg.stopEnd){ this._end(time); return; }
      dir = -dir; t = this.transpose + dir;
      if (!this.fits(t)){ this._end(time); return; }
    }

    this.transpose = t; this.dir = dir;
    this.steps = this.buildRep(t);
    this.ptr = 0;

    if (this.cfg.drone) this.audio.drone(true, this.cfg.rootMidi + t, time);
    Tone.Draw.schedule(() => this.h.onRep && this.h.onRep({ transpose: t, dir }), time);
  }
}
