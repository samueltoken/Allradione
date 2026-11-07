/** Perceptual display processing only; this never changes the audible signal. */
export class RadioSpectrum {
  readonly bandCount: number;
  /** Actual center frequencies for the current, adaptively occupied display range. */
  readonly centers: number[];
  private readonly firstBins: Uint16Array;
  private readonly lastBins: Uint16Array;
  private readonly levels: Float32Array;
  private readonly previousLevels: Float32Array;
  private readonly previousCenters: Float32Array;
  private readonly powers: Float64Array;
  private readonly bandDb: Float32Array;
  private readonly output: number[];
  private readonly binHz: number;
  private readonly lowHz: number;
  private readonly maximumHz: number;
  private readonly minimumHighHz: number;
  private upperHz: number;
  private rangePrimed = false;
  private narrowMs = 0;
  private referenceDb = -24;
  private primed = false;
  private gateOpen = false;

  constructor(sampleRate: number, fftSize: number, bandCount = 32) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isInteger(fftSize) || fftSize < 32 || fftSize > 32768 || (fftSize & (fftSize - 1)) !== 0) {
      throw new RangeError('Invalid FFT configuration');
    }
    if (!Number.isInteger(bandCount) || bandCount < 1 || bandCount > 96) throw new RangeError('Invalid band count');
    this.bandCount = bandCount;
    this.firstBins = new Uint16Array(bandCount);
    this.lastBins = new Uint16Array(bandCount);
    this.levels = new Float32Array(bandCount);
    this.previousLevels = new Float32Array(bandCount);
    this.previousCenters = new Float32Array(bandCount);
    this.powers = new Float64Array(fftSize / 2);
    this.bandDb = new Float32Array(bandCount);
    this.output = new Array<number>(bandCount).fill(0);
    this.centers = new Array<number>(bandCount).fill(0);
    this.binHz = sampleRate / fftSize;
    this.lowHz = Math.max(60, this.binHz);
    this.maximumHz = Math.max(this.lowHz, Math.min(12000, sampleRate * 0.46));
    this.minimumHighHz = Math.min(this.maximumHz, Math.max(400, this.lowHz * 4));
    this.upperHz = this.maximumHz;
    this.configureRange(this.upperHz, false);
  }

  /** Reuses the returned array. Consumers keeping a historical frame must copy it. */
  process(frequencyDb: Float32Array, rms: number, elapsedMs = 50): number[] {
    const dt = Number.isFinite(elapsedMs) ? Math.max(1, Math.min(250, elapsedMs)) : 50;
    const rmsDb = Number.isFinite(rms) && rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    // Hysteresis avoids chatter near silence. Low-level decoder noise cannot open the gate.
    this.gateOpen = this.gateOpen ? rmsDb > -76 : rmsDb > -70;
    let strongestDb = -Infinity;
    if (this.gateOpen) {
      this.updateOccupiedRange(frequencyDb, dt);
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
      // One shared gain curve keeps weak real detail visible without separately boosting noise.
      const target = Math.pow(normalized, 0.64);
      const tau = target > this.levels[band] ? 24 : 125;
      let level = this.levels[band] + (target - this.levels[band]) * (1 - Math.exp(-dt / tau));
      if (level < 0.002) level = 0;
      this.levels[band] = level;
      this.output[band] = Math.round(Math.max(0, Math.min(1, level)) * 1000) / 1000;
    }
    return this.output;
  }

  private updateOccupiedRange(frequencies: Float32Array, dt: number): void {
    const first = Math.max(1, Math.round(this.lowHz / this.binHz));
    const last = Math.min(frequencies.length - 1, this.powers.length - 1, Math.floor(this.maximumHz / this.binHz));
    let peakDb = -Infinity;
    for (let bin = first; bin <= last; bin += 1) {
      const db = frequencies[bin];
      if (Number.isFinite(db)) peakDb = Math.max(peakDb, Math.min(0, db));
    }
    if (!Number.isFinite(peakDb) || peakDb < -90) return;
    // Do not let a long, quiet codec-noise tail dictate the width of the visualizer.
    const thresholdDb = Math.max(-90, peakDb - 38);
    let total = 0;
    for (let bin = first; bin <= last; bin += 1) {
      const db = frequencies[bin];
      const power = Number.isFinite(db) && db >= thresholdDb ? Math.pow(10, Math.min(0, db) / 10) : 0;
      this.powers[bin] = power;
      total += power;
    }
    if (total <= 0) return;
    const retainedPower = total * 0.998;
    let cumulative = 0;
    let lastOccupied = first;
    for (let bin = first; bin <= last; bin += 1) {
      cumulative += this.powers[bin];
      if (this.powers[bin] > 0) lastOccupied = bin;
      if (cumulative >= retainedPower) break;
    }
    const target = Math.max(this.minimumHighHz, Math.min(this.maximumHz, (lastOccupied + 0.5) * this.binHz));
    let next = this.upperHz;
    if (!this.rangePrimed) {
      next = target;
      this.rangePrimed = true;
    } else if (target > this.upperHz * 1.03) {
      this.narrowMs = 0;
      next = target;
    } else if (target < this.upperHz * 0.94) {
      // A brief quiet phrase should not make every frequency slide across the display.
      this.narrowMs += dt;
      if (this.narrowMs >= 1000) next += (target - next) * (1 - Math.exp(-dt / 1100));
    } else {
      this.narrowMs = 0;
    }
    if (Math.abs(Math.log(next / this.upperHz)) > 0.002) this.configureRange(next, this.primed);
  }

  private configureRange(upperHz: number, preserveHistory: boolean): void {
    if (preserveHistory) {
      this.previousLevels.set(this.levels);
      this.previousCenters.set(this.centers);
    }
    this.upperHz = upperHz;
    const ratio = upperHz / this.lowHz;
    for (let band = 0; band < this.bandCount; band += 1) {
      const low = this.lowHz * Math.pow(ratio, band / this.bandCount);
      const high = this.lowHz * Math.pow(ratio, (band + 1) / this.bandCount);
      this.centers[band] = Math.sqrt(low * high);
      const first = Math.max(1, Math.min(this.powers.length - 1, Math.round(low / this.binHz)));
      this.firstBins[band] = first;
      this.lastBins[band] = Math.max(first + 1, Math.min(this.powers.length, Math.round(high / this.binHz)));
    }
    if (preserveHistory) {
      // Move the decay envelope with its real frequency when the occupied range changes.
      let previousBand = 0;
      for (let band = 0; band < this.bandCount; band += 1) {
        const hz = this.centers[band];
        while (previousBand < this.bandCount - 1 && this.previousCenters[previousBand + 1] < hz) previousBand += 1;
        if (hz > this.previousCenters[this.bandCount - 1]) this.levels[band] = 0;
        else if (previousBand >= this.bandCount - 1) this.levels[band] = this.previousLevels[previousBand];
        else {
          const start = this.previousCenters[previousBand];
          const end = this.previousCenters[previousBand + 1];
          const mix = Math.max(0, Math.min(1, (hz - start) / Math.max(1, end - start)));
          this.levels[band] = this.previousLevels[previousBand] * (1 - mix) + this.previousLevels[previousBand + 1] * mix;
        }
      }
    }
  }

  reset(): void {
    this.levels.fill(0);
    this.bandDb.fill(-Infinity);
    this.output.fill(0);
    this.referenceDb = -24;
    this.primed = false;
    this.gateOpen = false;
    this.rangePrimed = false;
    this.narrowMs = 0;
    this.configureRange(this.maximumHz, false);
  }
}
