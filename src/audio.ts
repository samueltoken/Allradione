import Hls from 'hls.js';
import type { AllradioneBridge, PlayerState, Station } from './types';

/** One playback owner lives in the main renderer, even while its window is hidden. */
export class RadioPlayer {
  private readonly audio = new Audio();
  private hls: Hls | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private frequencyData: Uint8Array<ArrayBuffer> | null = null;
  private generation = 0;
  private attempt = 0;
  private retryCount = 0;
  private active = false;
  private destroyed = false;
  private clickReported = false;
  private visualizing = false;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private spectrumTimer: ReturnType<typeof setInterval> | null = null;
  private snapshot: PlayerState = { station: null, playing: false, status: 'idle', volume: 0.7 };

  constructor(private readonly bridge: AllradioneBridge, private readonly onState: (state: PlayerState) => void) {
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'none';
    this.audio.volume = this.snapshot.volume;
    this.audio.addEventListener('playing', this.onPlaying);
    this.audio.addEventListener('waiting', this.onWaiting);
    this.audio.addEventListener('stalled', this.onWaiting);
    this.audio.addEventListener('error', this.onError);
    this.audio.addEventListener('ended', this.onEnded);
    this.bindMediaSession();
  }

  get state(): PlayerState {
    return { ...this.snapshot, spectrum: this.snapshot.spectrum?.slice() };
  }

  async play(station: Station): Promise<void> {
    if (this.destroyed) return;
    const generation = ++this.generation;
    this.disposeConnection();
    this.retryCount = 0;
    this.clickReported = false;
    this.snapshot = { station, playing: false, status: 'connecting', volume: this.audio.volume };
    this.emit();
    this.updateMetadata(station);
    // AudioContext resume must be initiated in the user gesture, before network awaits.
    void this.ensureAudioContext();
    await this.connect(generation);
  }

  async toggle(): Promise<void> {
    if (this.destroyed || !this.snapshot.station) return;
    if (this.snapshot.playing || this.snapshot.status === 'connecting') {
      ++this.generation;
      this.disposeConnection();
      this.snapshot = { ...this.snapshot, playing: false, status: 'paused', error: undefined, spectrum: undefined };
      this.setMediaPlaybackState('paused');
      this.emit();
    } else {
      // A live stream is re-opened so resume returns to live rather than an old buffer.
      await this.play(this.snapshot.station);
    }
  }

  stop(): void {
    if (this.destroyed) return;
    ++this.generation;
    this.disposeConnection();
    this.snapshot = { station: null, playing: false, status: 'idle', volume: this.audio.volume };
    this.setMediaPlaybackState('none');
    this.emit();
  }

  setVolume(value: number): void {
    if (!Number.isFinite(value)) return;
    this.audio.volume = Math.max(0, Math.min(1, value));
    this.snapshot.volume = this.audio.volume;
    this.emit();
  }

  setVisualizing(enabled: boolean): void {
    this.visualizing = enabled;
    if (enabled && !this.spectrumTimer) {
      this.spectrumTimer = setInterval(() => this.sampleSpectrum(), 100);
    } else if (!enabled && this.spectrumTimer) {
      clearInterval(this.spectrumTimer);
      this.spectrumTimer = null;
      if (this.snapshot.spectrum) {
        this.snapshot.spectrum = undefined;
        this.emit();
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    ++this.generation;
    this.disposeConnection();
    this.destroyed = true;
    if (this.spectrumTimer) clearInterval(this.spectrumTimer);
    this.audio.removeEventListener('playing', this.onPlaying);
    this.audio.removeEventListener('waiting', this.onWaiting);
    this.audio.removeEventListener('stalled', this.onWaiting);
    this.audio.removeEventListener('error', this.onError);
    this.audio.removeEventListener('ended', this.onEnded);
    this.source?.disconnect();
    this.analyser?.disconnect();
    void this.context?.close();
    if ('mediaSession' in navigator) {
      for (const action of ['play', 'pause', 'stop', 'previoustrack', 'nexttrack'] as const) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch { /* Optional platform feature. */ }
      }
    }
  }

  private async connect(generation: number): Promise<void> {
    if (!this.current(generation) || !this.snapshot.station) return;
    const station = this.snapshot.station;
    const attempt = ++this.attempt;
    this.active = true;
    this.snapshot.status = 'connecting';
    this.snapshot.playing = false;
    this.snapshot.error = undefined;
    this.emit();
    this.armDeadline(generation, attempt);
    try {
      const rawUrl = station.url_resolved || station.url;
      if (!/^https?:\/\//i.test(rawUrl)) throw new Error('재생 가능한 방송 주소가 없어.');
      const proxiedUrl = await this.bridge.streamUrl(rawUrl);
      if (!this.current(generation, attempt)) return;
      const isHls = station.hls === 1 || /\.m3u8(?:[?#]|$)/i.test(rawUrl);
      if (isHls && Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 10,
          maxBufferLength: 20,
          manifestLoadingTimeOut: 12000,
          manifestLoadingMaxRetry: 0,
          levelLoadingMaxRetry: 0,
          fragLoadingMaxRetry: 1,
        });
        this.hls = hls;
        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          if (this.current(generation, attempt)) hls.loadSource(proxiedUrl);
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (this.current(generation, attempt)) void this.beginPlayback(generation, attempt);
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || !this.current(generation, attempt)) return;
          this.fail(generation, attempt, data.type === Hls.ErrorTypes.MEDIA_ERROR
            ? '이 방송의 오디오 형식을 재생할 수 없어.'
            : '방송 연결이 끊겼어. 잠시 후 다시 시도해줘.');
        });
        hls.attachMedia(this.audio);
      } else {
        if (isHls && !this.audio.canPlayType('application/vnd.apple.mpegurl')) {
          this.fail(generation, attempt, '이 환경에서는 HLS 방송을 재생할 수 없어.', false);
          return;
        }
        this.audio.src = proxiedUrl;
        this.audio.load();
        await this.beginPlayback(generation, attempt);
      }
    } catch (error) {
      if (!this.current(generation, attempt)) return;
      this.fail(generation, attempt, '방송에 연결하지 못했어. 잠시 후 다시 시도해줘.');
    }
  }

  private async beginPlayback(generation: number, attempt: number): Promise<void> {
    try {
      await this.ensureAudioContext();
      if (!this.current(generation, attempt)) return;
      await this.audio.play();
      // The `playing` event is the only source of the playing state.
    } catch (error) {
      if (!this.current(generation, attempt)) return;
      const blocked = error instanceof DOMException && error.name === 'NotAllowedError';
      this.fail(generation, attempt, blocked
        ? '재생 버튼을 눌러 방송을 시작해줘.'
        : '방송을 재생하지 못했어. 다른 방송을 선택하거나 다시 시도해줘.', !blocked);
    }
  }

  private readonly onPlaying = (): void => {
    if (!this.active || this.destroyed || !this.snapshot.station) return;
    const stationId = this.snapshot.station.stationuuid;
    this.clearDeadline();
    this.snapshot = { ...this.snapshot, playing: true, status: 'playing', error: undefined };
    this.setMediaPlaybackState('playing');
    this.emit();
    if (!this.clickReported) {
      this.clickReported = true;
      void this.bridge.stationClick(stationId).catch(() => {});
    }
  };

  private readonly onWaiting = (): void => {
    if (!this.active || this.destroyed || this.snapshot.status === 'error') return;
    this.snapshot = { ...this.snapshot, playing: false, status: 'connecting', spectrum: undefined };
    this.emit();
    // Repeated stalled/waiting events must not keep extending the deadline forever.
    if (!this.deadline) this.armDeadline(this.generation, this.attempt);
  };

  private readonly onError = (): void => {
    if (!this.active || this.destroyed) return;
    const unsupported = this.audio.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
    this.fail(this.generation, this.attempt, unsupported
      ? '방송 주소 또는 오디오 형식을 재생할 수 없어.'
      : '방송 서버에 연결하지 못했어. 다시 시도해줘.', !unsupported);
  };

  private readonly onEnded = (): void => {
    if (this.active && !this.destroyed) this.fail(this.generation, this.attempt, '방송 송출이 중단됐어.');
  };

  private fail(generation: number, attempt: number, message: string, retry = true): void {
    if (!this.current(generation, attempt)) return;
    this.disposeConnection();
    if (retry && this.retryCount < 2) {
      this.retryCount += 1;
      this.snapshot = { ...this.snapshot, playing: false, status: 'connecting', spectrum: undefined };
      this.emit();
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.current(generation)) void this.connect(generation);
      }, this.retryCount * 1250);
    } else {
      this.snapshot = { ...this.snapshot, playing: false, status: 'error', error: message, spectrum: undefined };
      this.setMediaPlaybackState('paused');
      this.emit();
    }
  }

  private current(generation: number, attempt?: number): boolean {
    return !this.destroyed && this.generation === generation && (attempt === undefined || (this.attempt === attempt && this.active));
  }

  private armDeadline(generation: number, attempt: number): void {
    this.clearDeadline();
    this.deadline = setTimeout(() => {
      this.deadline = null;
      if (this.current(generation, attempt)) this.fail(generation, attempt, '방송 응답이 없어. 다른 방송을 선택하거나 다시 시도해줘.');
    }, 18000);
  }

  private clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
  }

  private disposeConnection(): void {
    this.active = false;
    this.clearDeadline();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.hls?.destroy();
    this.hls = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  private async ensureAudioContext(): Promise<void> {
    if (!this.context) {
      try {
        this.context = new AudioContext();
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.72;
        this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
        this.source = this.context.createMediaElementSource(this.audio);
        this.source.connect(this.analyser);
        this.analyser.connect(this.context.destination);
      } catch {
        // Visualization is optional; an unavailable Web Audio API must not fail radio playback.
        this.analyser = null;
        this.frequencyData = null;
      }
    }
    if (this.context?.state === 'suspended') {
      try { await this.context.resume(); } catch { /* Playback reports a user-gesture block separately. */ }
    }
  }

  private sampleSpectrum(): void {
    if (!this.visualizing || !this.snapshot.playing || !this.analyser || !this.frequencyData) return;
    this.analyser.getByteFrequencyData(this.frequencyData);
    const count = 32;
    const result: number[] = [];
    for (let band = 0; band < count; band += 1) {
      const start = Math.floor(Math.pow(band / count, 1.55) * this.frequencyData.length);
      const end = Math.max(start + 1, Math.floor(Math.pow((band + 1) / count, 1.55) * this.frequencyData.length));
      let sum = 0;
      for (let bin = start; bin < end; bin += 1) sum += this.frequencyData[bin] ?? 0;
      result.push(Number((sum / (end - start) / 255).toFixed(3)));
    }
    this.snapshot.spectrum = result;
    this.emit();
  }

  private emit(): void {
    if (this.destroyed) return;
    const state = this.state;
    this.onState(state);
    this.bridge.publishPlayer(state);
  }

  private updateMetadata(station: Station): void {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: station.name, artist: station.countrycode || 'Internet radio', album: 'Allradione' });
    } catch { /* Metadata may be unavailable on the current platform. */ }
  }

  private setMediaPlaybackState(state: MediaSessionPlaybackState): void {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  }

  private bindMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const handlers: Partial<Record<MediaSessionAction, () => void>> = {
      play: () => { if (this.snapshot.station && !this.snapshot.playing) void this.play(this.snapshot.station); },
      pause: () => { if (this.snapshot.playing || this.snapshot.status === 'connecting') void this.toggle(); },
      stop: () => this.stop(),
      previoustrack: () => this.bridge.sendCommand('previous'),
      nexttrack: () => this.bridge.sendCommand('next'),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler); } catch { /* Unsupported media key. */ }
    }
  }
}
