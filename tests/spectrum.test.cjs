const test = require('node:test');
const assert = require('node:assert/strict');
let RadioSpectrum;
test.before(async () => { ({ RadioSpectrum } = await import('../src/spectrum.ts')); });
const dbFrame = (size = 2048) => new Float32Array(size / 2).fill(-Infinity);
const tone = (frame, hz, db, sampleRate = 48000) => { frame[Math.round(hz / (sampleRate / (frame.length * 2)))] = db; return frame; };
const strongestBand = levels => levels.indexOf(Math.max(...levels));

test('silence and sub-gate noise never manufacture motion', () => {
  const spectrum = new RadioSpectrum(48000, 2048);
  const silence = dbFrame();
  assert.ok(spectrum.process(silence, 0).every(value => value === 0));
  const noise = new Float32Array(1024).fill(-65);
  for (let i = 0; i < 20; i++) assert.ok(spectrum.process(noise, 0.00001).every(value => value === 0));
});

test('adaptive logarithmic bands preserve real low-to-high frequency order', () => {
  const spectrum = new RadioSpectrum(48000, 2048);
  for (const hz of [120, 1000, 6000]) {
    spectrum.reset();
    const levels = spectrum.process(tone(dbFrame(), hz, -24), 0.1);
    const band = strongestBand(levels);
    assert.ok(Math.max(...levels) > 0.7, `${hz}Hz should be clearly visible`);
    assert.ok(Math.abs(Math.log2(spectrum.centers[band] / hz)) < 0.4, `${hz}Hz must light the matching band`);
    for (let i = 0; i < levels.length; i++) {
      if (levels[i]) assert.ok(Math.abs(Math.log2(spectrum.centers[i] / hz)) < 0.4, 'a pure tone must not light unrelated frequencies');
    }
  }
  spectrum.reset();
  const chord = tone(tone(tone(dbFrame(), 120, -24), 1000, -24), 6000, -24);
  const levels = spectrum.process(chord, 0.2);
  const indices = [120, 1000, 6000].map(hz => spectrum.centers.findIndex((center, i) => Math.abs(Math.log2(center / hz)) < 0.4 && levels[i] > 0.6));
  assert.ok(indices[0] >= 0 && indices[0] < indices[1] && indices[1] < indices[2]);
});

test('quiet streams remain legible without flattening louder transients', () => {
  const spectrum = new RadioSpectrum(48000, 2048);
  const quiet = tone(dbFrame(), 1000, -58);
  let levels;
  for (let i = 0; i < 20; i++) levels = spectrum.process(quiet, 0.0015);
  const quietPeak = Math.max(...levels);
  assert.ok(quietPeak > 0.5 && quietPeak < 0.95);
  const loudPeak = Math.max(...spectrum.process(tone(dbFrame(), 1000, -20), 0.1));
  assert.ok(loudPeak > quietPeak + 0.1, 'a louder beat must produce a clear jump');
});

test('attack responds within one frame and release returns fully to silence', () => {
  const spectrum = new RadioSpectrum(48000, 2048);
  const first = Math.max(...spectrum.process(tone(dbFrame(), 250, -18), 0.15, 50));
  assert.ok(first > 0.7);
  const release = Math.max(...spectrum.process(dbFrame(), 0, 50));
  assert.ok(release < first && release > 0, 'release should decay rather than instantly disappear');
  let levels;
  for (let i = 0; i < 20; i++) levels = spectrum.process(dbFrame(), 0, 50);
  assert.ok(levels.every(value => value === 0));
});

test('processor reuses storage, clamps invalid samples, and resets channel history', () => {
  const spectrum = new RadioSpectrum(44100, 2048);
  const frame = dbFrame(); frame[20] = NaN; frame[25] = Infinity; frame[30] = 10;
  const first = spectrum.process(frame, 0.2);
  assert.equal(first, spectrum.process(frame, 0.2));
  assert.ok(first.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  spectrum.reset();
  assert.ok(spectrum.process(dbFrame(), 0).every(value => value === 0));
});

function musicSpectrum(cutoff, noiseDb = -Infinity) {
  const frame = new Float32Array(1024).fill(noiseDb);
  for (let bin = 3; bin < frame.length; bin++) {
    const hz = bin * 48000 / 2048;
    if (hz <= cutoff) frame[bin] = -25 - 4.5 * Math.log2(Math.max(1, hz / 120));
  }
  return frame;
}

test('wideband and low-pass music occupy the available width without inventing a treble tail', () => {
  for (const cutoff of [2200, 4000, 11500]) {
    const spectrum = new RadioSpectrum(48000, 2048);
    const levels = spectrum.process(musicSpectrum(cutoff, -90), 0.15);
    assert.ok(levels[31] > 0.2, `${cutoff}Hz stream must use the last band`);
    assert.ok(levels.filter(value => value > 0.15).length >= 28);
    assert.ok(spectrum.centers[31] < cutoff * 1.05, 'display must not devote its right side to absent frequencies');
    assert.ok(spectrum.centers[31] > cutoff * 0.75, 'meaningful higher frequencies must remain represented');
  }
});

test('range survives short phrases, narrows for sustained low-pass audio, and expands for new treble', () => {
  const spectrum = new RadioSpectrum(48000, 2048);
  spectrum.process(musicSpectrum(11500), 0.15);
  const initial = spectrum.centers[31];
  for (let i = 0; i < 10; i++) spectrum.process(musicSpectrum(2500), 0.15);
  assert.equal(spectrum.centers[31], initial, 'half-second quiet phrase must not rescale the display');
  let levels;
  for (let i = 0; i < 140; i++) levels = spectrum.process(musicSpectrum(2500), 0.15);
  assert.ok(levels[31] > 0.2, 'sustained lower bandwidth must reach the right edge');
  assert.ok(spectrum.centers[31] < 2800);
  spectrum.process(musicSpectrum(11500), 0.15);
  assert.ok(spectrum.centers[31] > 10000, 'new high-frequency content must not be clipped while the range expands');
});

test('quiet high-frequency codec noise cannot stretch or independently inflate the display', () => {
  const spectrum = new RadioSpectrum(48000, 2048);
  const levels = spectrum.process(musicSpectrum(2800, -85), 0.15);
  assert.ok(spectrum.centers[31] < 3000);
  assert.ok(levels[31] > 0.2);
  spectrum.reset();
  assert.ok(spectrum.process(new Float32Array(1024).fill(-85), 0.00001).every(value => value === 0));
});
