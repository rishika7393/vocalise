# Vocalise

Scale practice for singers. Two pages: one that plays exercises up and down the
ladder, one that listens to you sing them back.

No build step, no bundler, no framework. Plain ES modules and one CDN
dependency (Tone.js) for audio scheduling.

## Running it locally

ES modules will not load from `file://`, so double-clicking `index.html` will
not work. Serve the folder:

```
cd vocalise
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

The microphone needs a secure context. `localhost` counts as secure, so the
sing-back page works locally without any certificate fiddling.

## Deploying

It is a static site. Anything that serves files works, with no configuration:

- **Cloudflare Pages / Netlify** — drag the folder onto the dashboard. Done.
- **GitHub Pages** — push the folder, enable Pages on the branch.
- **Vercel** — `vercel deploy` in the folder, accept the defaults.

The only requirement is **HTTPS**, which all of the above give you for free.
Without it browsers refuse microphone access, so the sing-back page will fail
while the practice page carries on fine.

To work fully offline, download Tone.js into `vendor/` and point the `CDN`
array in `js/audio.js` at your local copy.

## The files

```
index.html          practice — play the exercise, climb the ladder
sing.html           sing back — score your pitch, or build an exercise by singing
css/app.css         all styling for both pages
js/theory.js        scales, degree maths, note naming, Hz/MIDI/cents
js/store.js         storage adapter and saved exercises
js/audio.js         Tone.js wrapper: synth, drone, click, context priming
js/runner.js        the scheduler — builds passes, walks the ladder
js/visual.js        keyboard and contour painting, shared by both pages
js/pitch.js         microphone pitch detection and note segmentation
js/practice.js      practice page controller
js/sing.js          sing-back page controller
```

`theory.js`, `runner.js` and `pitch.js` have no DOM dependencies, so they can be
tested in Node directly.

## Note lengths

A sequence step is `{ d: degree, len: ticks }`, where a tick is a sixteenth
note. So `len` 4 is one beat, 2 a half beat, 3 a dotted half beat, 8 two beats.
The runner schedules on a sixteenth grid and counts down each step's ticks,
which is what lets one pass mix lengths.

In the builder, tap a step to select it and set its length; chip width shows the
length, so the rhythm is readable without counting. The `♩ ♪ ♬` buttons in the
strip set the default for new notes, and additionally even out the whole
sequence *if every note currently shares one length* — so they still read as
"make it all faster" on a uniform exercise without flattening a rhythm you
built deliberately. There's an explicit "Even out" button too.

In the command bar, `1 2 3 4 5*4` holds that last degree four times as long as
the default.

Older saved data stored bare degrees with one global length.
`normalizeSequence` in `theory.js` accepts both shapes, so nothing breaks.

## Jumping to a note

Tap any note in the contour. Mid-exercise it restarts the current pass from
there, on the next sixteenth so it stays locked to the metronome instead of
lurching. While stopped it just plays that note so you can check it. Notes are
keyboard reachable and respond to Enter.

On the sing-back page a jump also clears the scores from that note onward, so
the retry replaces the attempt rather than appending to it.

## Notes on a few decisions

**Why start feels immediate.** Browsers keep the AudioContext suspended until a
user gesture, and building a PolySynth costs a few hundred milliseconds the
first time. `primeOnFirstGesture` in `audio.js` does both on the first touch
anywhere on the page rather than on the Start button, so by the time you press
Start the graph is warm. Tone's scheduling lookahead is also halved to 50ms, and
Learn mode never counts in — a four-beat count-in was most of the wait.

**Why there is no theory library.** Scale formulas plus degree-to-semitone
arithmetic is about 40 lines. A dependency here would be larger than the code it
replaces, and one more thing to break.

**Why the command bar is a regex.** "C major 1 2 3 2 1 at 90bpm" is a
well-structured phrase. A parser handles it with no latency, no cost and no
network. It lives at the bottom of `js/practice.js`.

**Pitch detection.** YIN's cumulative mean normalised difference function, run
at half sample rate to find the period cheaply, then refined at full rate around
that guess. Measured under a cent of error from 82Hz to 880Hz on synthetic
tones. Echo cancellation, noise suppression and auto gain are all switched off
in the `getUserMedia` constraints — every one of them fights pitch detection.

**Scoring.** Each note is judged on the steady middle 55% of how you sang it, so
the scoop into a note is ignored. Octaves are folded together before comparing,
so singing the whole exercise an octave down still scores as correct.

## Known limits

- Two identical pitches sung joined together read as one held note when
  capturing. Leave a small gap.
- No triplets yet. Note lengths are sixteenth-grid values, so quarters,
  eighths, sixteenths and dotted versions work, but nothing that divides a beat
  into three.
- Accidentals are spelled from the tonic's pitch class rather than a real key
  signature, so a few enharmonics read oddly.
- Saved exercises live in one browser. There is no account or sync.
