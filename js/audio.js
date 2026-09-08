// Thin wrapper over Tone.js. The important part here is prime(): browsers keep
// the AudioContext suspended until a user gesture, and building a PolySynth
// costs a few hundred milliseconds the first time. Doing both on the first
// touch anywhere on the page — rather than on the Start button — is what makes
// Start feel instant.

import { midiToHz } from './theory.js';

const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js',
  'https://cdnjs.cloudflare.com/ajax/libs/tone/14.7.77/Tone.js',
  'https://cdnjs.cloudflare.com/ajax/libs/tone/15.0.4/Tone.js',
];

function loadScript(i = 0){
  return new Promise((resolve, reject) => {
    if (i >= CDN.length) return reject(new Error('Tone.js unavailable'));
    const s = document.createElement('script');
    s.src = CDN[i];
    s.onload = resolve;
    s.onerror = () => loadScript(i + 1).then(resolve, reject);
    document.head.appendChild(s);
  });
}

export class Audio {
  constructor(){
    this.loaded = false;
    this.primed = false;
    this.nodes = null;
    this.voice = 'triangle';
    this.volume = -6;
  }

  async load(){
    if (this.loaded) return;
    await loadScript();
    // Tone defaults to 100ms of scheduling lookahead. Halving it tightens the
    // gap between pressing Start and hearing the first note without risking
    // dropouts on normal hardware.
    try { Tone.context.lookAhead = 0.05; } catch (e) { /* older builds */ }
    this.loaded = true;
  }

  // Safe to call repeatedly; only the first call does work.
  async prime(){
    if (!this.loaded || this.primed) return;
    await Tone.start();
    this.build();
    // Render one inaudible note so the graph is compiled and warm.
    this.nodes.synth.triggerAttackRelease(440, 0.02, undefined, 0.0001);
    this.primed = true;
  }

  build(){
    if (this.nodes) return this.nodes;
    const out = new Tone.Gain(1).toDestination();

    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: this.voice },
      envelope: { attack: 0.008, decay: 0.16, sustain: 0.45, release: 0.35 },
    }).connect(out);
    synth.volume.value = -4;

    const droneGain  = new Tone.Gain(0).connect(out);
    const droneOsc   = new Tone.Oscillator(110, 'sine').connect(droneGain).start();
    const droneFifth = new Tone.Oscillator(165, 'sine').connect(droneGain).start();
    droneFifth.volume.value = -8;

    const click = new Tone.MembraneSynth({
      pitchDecay: 0.008, octaves: 2,
      envelope: { attack: 0.001, decay: 0.09, sustain: 0 },
    }).connect(out);
    click.volume.value = -12;

    this.nodes = { out, synth, droneGain, droneOsc, droneFifth, click };
    Tone.Destination.volume.value = this.volume;
    return this.nodes;
  }

  setVoice(type){
    this.voice = type;
    if (this.nodes) this.nodes.synth.set({ oscillator: { type } });
  }

  setVolume(db){
    this.volume = db;
    if (this.loaded) Tone.Destination.volume.value = db;
  }

  note(midi, dur, time, vel = 0.9){
    if (!this.nodes) return;
    this.nodes.synth.triggerAttackRelease(midiToHz(midi), dur, time, vel);
  }

  click(accent, time){
    if (!this.nodes) return;
    this.nodes.click.triggerAttackRelease(accent ? 'C3' : 'G2', '32n', time, accent ? 1 : 0.55);
  }

  // The drone sits two octaves under the tonic, root and fifth, very quiet.
  drone(on, midi, time){
    if (!this.nodes) return;
    if (!on){ this.nodes.droneGain.gain.rampTo(0, 0.2); return; }
    const hz = midiToHz(midi - 24);
    if (time != null){
      this.nodes.droneOsc.frequency.rampTo(hz, 0.12, time);
      this.nodes.droneFifth.frequency.rampTo(hz * 1.5, 0.12, time);
    } else {
      this.nodes.droneOsc.frequency.value = hz;
      this.nodes.droneFifth.frequency.value = hz * 1.5;
    }
    this.nodes.droneGain.gain.rampTo(0.08, 0.3);
  }

  releaseAll(){ if (this.nodes) this.nodes.synth.releaseAll(); }
}

// Wire prime() to the first interaction anywhere on the page.
export function primeOnFirstGesture(audio){
  const go = () => {
    audio.prime().catch(() => {});
    window.removeEventListener('pointerdown', go, true);
    window.removeEventListener('keydown', go, true);
  };
  window.addEventListener('pointerdown', go, true);
  window.addEventListener('keydown', go, true);
}
