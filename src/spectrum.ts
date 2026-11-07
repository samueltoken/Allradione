/** Perceptual display processing only; this never changes the audible signal. */
export class RadioSpectrum {
  readonly bandCount: number;
  readonly centers: readonly number[];
  private readonly firstBins: Uint16Array;
  private readonly lastBins: Uint16Array;
  private readonly levels: Float32Array;
  private readonly bandDb: Float32Array;
  private readonly output: number[];
  private referenceDb = -24;
  private primed = false;
  private gateOpen = false;

  constructor(sampleRate: number, fftSize: number, bandCount = 32) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isInteger(fftSize) || fftSize < 32) {
      throw new RangeError('Invalid FFT configuration');
    }
    if (!Number.isInteger(bandCount) || bandCount < 1 || bandCount > 96) throw new RangeError('Invalid band count');
    this.bandCount = bandCount;
    this.firstBins = new Uint16Array(bandCount);
    this.lastBins = new Uint16Array(bandCount);
    this.levels = new Float32Array(bandCount);
    this.bandDb = new Float32Array(bandCount);
    this.output = new Array<number>(bandCount).fill(0);
    const centers: number[] = [];
    const binHz = sampleRate / fftSize;
    const lowHz = Math.max(60, binHz);
    const highHz = Math.max(lowHz, Math.min(12000, sampleRate * 0.46));
    const ratio = highHz / lowHz;
    for (let band = 0; band < bandCount; band += 1) {
      const low = lowHz * Math.pow(ratio, band / bandCount);
      const high = lowHz * Math.pow(ratio, (band + 1) / bandCount);
      centers.push(Math.sqrt(low * high));
      // Round to the nearest FFT bin so a narrow bass band still has a real sample.
      const first = Math.max(1, Math.min(fftSize / 2 - 1, Math.round(low / binHz)));
      const last = Math.max(first + 1, Math.min(fftSize / 2, Math.round(high / binHz)));
      this.firstBins[band] = first;
      this.lastBins[band] = last;
    }
    this.centers = centers;
  }

  /** Reuses the returned array. Consumers keeping a historical frame must copy it. */
  process(frequencyDb: Float32Array, rms: number, elapsedMs = 50): number[] {
    const dt = Number.isFinite(elapsedMs) ? Math.max(1, Math.min(250, elapsedMs)) : 50;
    const rmsDb = Number.isFinite(rms) && rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    // Hysteresis avoids chatter near silence. Broadcast noise below -72 dB is not animated.
    this.gateOpen = this.gateOpen ? rmsDb > -76 : rmsDb > -70;
    let strongestDb = -Infinity;
    if (this.gateOpen) {
      for (let band = 0; band < this.bandCount; band += 1) {
        let peakPower = 0;
        let sumPower = 0;
        let count = 0;
        for (let bin = this.firstBins[band]; bin < this.lastBins[band] && bin < frequencyDb.length; bin += 1) {
          const db = frequencyDb[bin];
          if (!Number.isFinite(db) || db < -110) continue;
          const power = Math.pow(10, Math.min(0, db) / 10);
          peakPower = Math.max(peakPower, power);
          sumPower += power;
          count += 1;
        }
        // Peak-weighted power preserves narrow voices/instruments inside wide treble bands.
        const power = count ? peakPower * 0.7 + sumPower / count * 0.3 : 0;
        const db = power > 0 ? 10 * Math.log10(power) : -Infinity;
        this.bandDb[band] = db;
        strongestDb = Math.max(strongestDb, db);
      }
      if (Number.isFinite(strongestDb)) {
        const targetReference = Math.max(-48, Math.min(-3, strongestDb + 6));
        if (!this.primed) {
          this.referenceDb = targetReference;
          this.primed = true;
        } else {
          // Slow gain recovery leaves quieter passages and individual beats visibly distinct.
          const referenceTime = targetReference > this.referenceDb ? 450 : 5000;
          this.referenceDb += (targetReference - this.referenceDb) * (1 - Math.exp(-dt / referenceTime));
        }
      }
    }
    const floorDb = Math.max(-90, this.referenceDb - 48);
    for (let band = 0; band < this.bandCount; band += 1) {
      const normalized = this.gateOpen && Number.isFinite(this.bandDb[band])
        ? Math.max(0, Math.min(1, (this.bandDb[band] - floorDb) / 48)) : 0;
      // Gentle compression makes quiet but real detail legible without filling silent bands.
      const target = Math.pow(normalized, 0.72);
      const tau = target > this.levels[band] ? 24 : 125;
      let level = this.levels[band] + (target - this.levels[band]) * (1 - Math.exp(-dt / tau));
      if (level < 0.002) level = 0;
      this.levels[band] = level;
      this.output[band] = Math.round(Math.max(0, Math.min(1, level)) * 1000) / 1000;
    }
    return this.output;
  }

  reset(): void {
    this.levels.fill(0);
    this.bandDb.fill(-Infinity);
    this.output.fill(0);
    this.referenceDb = -24;
    this.primed = false;
    this.gateOpen = false;
  }
}
