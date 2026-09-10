// Everything the app knows about notes. No dependencies — this is 60 lines of
// arithmetic, which is why there's no theory library in package.json.

export const SHARP = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
export const FLAT  = ['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];
export const SOLFEGE = ['do','ra','re','me','mi','fa','fi','sol','le','la','te','ti'];
export const BLACK_PC = [1,3,6,8,10];
export const FLAT_PC  = [1,3,6,8,10];

// The outer guard rails. Nothing is ever sounded below or above these.
export const LO = 36;  // C2
export const HI = 88;  // E6

export const SCALES = {
  major:      { label:'Major',            steps:[0,2,4,5,7,9,11], alias:['major','ionian'] },
  minor:      { label:'Natural minor',    steps:[0,2,3,5,7,8,10], alias:['natural minor','minor','aeolian'] },
  harmonic:   { label:'Harmonic minor',   steps:[0,2,3,5,7,8,11], alias:['harmonic minor','harmonic'] },
  melodic:    { label:'Melodic minor',    steps:[0,2,3,5,7,9,11], alias:['melodic minor','melodic'] },
  dorian:     { label:'Dorian',           steps:[0,2,3,5,7,9,10], alias:['dorian'] },
  phrygian:   { label:'Phrygian',         steps:[0,1,3,5,7,8,10], alias:['phrygian'] },
  lydian:     { label:'Lydian',           steps:[0,2,4,6,7,9,11], alias:['lydian'] },
  mixolydian: { label:'Mixolydian',       steps:[0,2,4,5,7,9,10], alias:['mixolydian'] },
  majpent:    { label:'Major pentatonic', steps:[0,2,4,7,9],      alias:['major pentatonic','maj pent'] },
  minpent:    { label:'Minor pentatonic', steps:[0,3,5,7,10],     alias:['minor pentatonic','min pent','pentatonic'] },
  blues:      { label:'Blues',            steps:[0,3,5,6,7,10],   alias:['blues'] },
  chromatic:  { label:'Chromatic',        steps:[0,1,2,3,4,5,6,7,8,9,10,11], alias:['chromatic'] },
};

// Note lengths, measured in sixteenth-note ticks — the grid the runner ticks on.
export const LENGTHS = [
  { ticks:1, label:'\u00bc',  name:'quarter beat' },
  { ticks:2, label:'\u00bd',  name:'half beat' },
  { ticks:3, label:'\u00be',  name:'three quarter beats' },
  { ticks:4, label:'1',   name:'one beat' },
  { ticks:6, label:'1\u00bd', name:'one and a half beats' },
  { ticks:8, label:'2',   name:'two beats' },
];

// A sequence step is { d: degree|null, len: ticks }. Older saved data stored
// bare degrees with one global length, so accept both shapes.
export function normalizeSequence(seq, defLen = 2){
  if (!Array.isArray(seq)) return [];
  return seq.map(s => {
    if (typeof s === 'number') return { d: s, len: defLen };
    if (s && typeof s === 'object'){
      const d = s.d !== undefined ? s.d : (s.deg !== undefined ? s.deg : null);
      return { d: d == null ? null : d, len: Math.max(1, s.len || defLen) };
    }
    return { d: null, len: defLen };
  });
}

export const isUniform = seq => seq.length > 0 && seq.every(s => s.len === seq[0].len);
export const totalTicks = seq => seq.reduce((a, s) => a + Math.max(1, s.len), 0);

export const PRESETS = [
  { label:'Three notes up and back — 1 2 3 2 1',        seq:[1,2,3,2,1] },
  { label:'Five notes up and back — 1 2 3 4 5 4 3 2 1', seq:[1,2,3,4,5,4,3,2,1] },
  { label:'Five notes down — 5 4 3 2 1',                seq:[5,4,3,2,1] },
  { label:'Triad — 1 3 5 3 1',                          seq:[1,3,5,3,1] },
  { label:'Arpeggio to the octave — 1 3 5 8 5 3 1',     seq:[1,3,5,8,5,3,1] },
  { label:'Octave leap — 1 8 1',                        seq:[1,8,1] },
  { label:'Fifth and octave — 1 5 8 5 1',               seq:[1,5,8,5,1] },
  { label:'Full octave up — 1 to 8',                    seq:[1,2,3,4,5,6,7,8] },
  { label:'Full octave down — 8 to 1',                  seq:[8,7,6,5,4,3,2,1] },
  { label:'Full octave up and back',                    seq:[1,2,3,4,5,6,7,8,7,6,5,4,3,2,1] },
  { label:'Leading tone approach — 0 1 2 1 0',          seq:[0,1,2,1,0] },
  { label:'Five up, hold the top',
    seq:[{d:1,len:2},{d:2,len:2},{d:3,len:2},{d:4,len:2},{d:5,len:8}] },
  { label:'Long tonic, quick turn',
    seq:[{d:1,len:4},{d:2,len:1},{d:3,len:1},{d:2,len:1},{d:1,len:4}] },
  { label:'Dotted climb — long short, long short',
    seq:[{d:1,len:3},{d:2,len:1},{d:3,len:3},{d:4,len:1},{d:5,len:6}] },
  { label:'Octave, held at each end',
    seq:[{d:1,len:6},{d:3,len:2},{d:5,len:2},{d:8,len:6}] },
];

// Degree 1 is the tonic, 8 the octave. 0 and below dip under the tonic.
export function degToSemi(deg, steps){
  const n = steps.length, idx = deg - 1;
  const oct = Math.floor(idx / n);
  const i = ((idx % n) + n) % n;
  return steps[i] + 12 * oct;
}

export const pcOf     = m => ((m % 12) + 12) % 12;
export const octOf    = m => Math.floor(m / 12) - 1;
export const nameOf   = (m, flat) => (flat ? FLAT : SHARP)[pcOf(m)];
export const fullName = (m, flat) => nameOf(m, flat) + octOf(m);
export const isBlack  = m => BLACK_PC.includes(pcOf(m));
export const useFlats = rootPc => FLAT_PC.includes(rootPc);

export const midiToHz     = m => 440 * Math.pow(2, (m - 69) / 12);
export const hzToMidi     = hz => 69 + 12 * Math.log2(hz / 440);
export const centsBetween = (hz, midi) => 1200 * Math.log2(hz / midiToHz(midi));

// Which scale degree is this note, relative to a tonic? Used when capturing a
// sung melody. Returns the nearest degree plus how far off it landed.
export function nearestDegree(midi, rootMidi, steps){
  let best = null;
  for (let d = -6; d <= 15; d++){
    const target = rootMidi + degToSemi(d, steps);
    const dist = Math.abs(target - midi);
    if (!best || dist < best.dist) best = { deg: d, dist, midi: target };
  }
  return best;
}

export function seqToText(seq){
  return seq.map(s => {
    const d = (s && typeof s === 'object') ? s.d : s;
    return d == null ? '\u00b7' : d;
  }).join(' ');
}
