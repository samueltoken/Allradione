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

test('logarithmic bands distinguish bass, speech, and treble in useful ranges', () => {
  const spectrum = new RadioSpectrum(48000, 2048);
  const bandIndices = [];
  for (const hz of [120, 1000, 6000]) {
    spectrum.reset();
    const levels = spectrum.process(tone(dbFrame(), hz, -24), 0.1);
    const band = strongestBand(levels);
    bandIndices.push(band);
    assert.ok(Math.max(...levels) > 0.7, `${hz}Hz should be clearly visible`);
    assert.ok(Math.abs(Math.log2(spectrum.centers[band] / hz)) < 0.4, `${hz}Hz must light the matching band`);
    assert.ok(levels.filter(value => value > 0).length <= 2, 'a pure tone must not light unrelated bands');
  }
  assert.ok(bandIndices[0] < 10 && bandIndices[1] > 10 && bandIndices[2] > 24);
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
