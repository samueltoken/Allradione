import Hls from 'hls.js';
import { RadioSpectrum } from './spectrum';
import type { AllradioneBridge, PlayerState, Station } from './types';

function broadcastDenial(status: number | undefined) {
  if (status === 429) return '방송 서버가 요청 횟수를 제한했습니다. 잠시 후 다시 시도해 주세요. (429)';
  if (status === 401 || status === 403 || status === 451) return '방송 서버가 접근을 허용하지 않습니다. (' + status + ')';
  if (status === 404 || status === 410) return '방송 서버에서 재생 주소를 찾을 수 없습니다. (' + status + ')';
  return '';
}

/** One playback owner lives in the main renderer, even while its window is hidden. */
export class RadioPlayer {
  private readonly audio = new Audio();
  private hls: Hls | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private frequencyData: Float32Array<ArrayBuffer> | null = null;
  private timeData: Float32Array<ArrayBuffer> | null = null;
  private spectrum: RadioSpectrum | null = null;
  private spectrumSampleTime = 0;
  private generation = 0;
  private attempt = 0;
  private retryCount = 0;
  private playingSince = 0;
  private sources: string[] = [];
  private sourceIndex = 0;
  private active = false;
  private destroyed = false;
  private clickReported = false;
  private visualizing = false;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private scheduleEnd: ReturnType<typeof setTimeout> | null = null;
  private probe: AbortController | null = null;
  private directSource = '';
  private detectedHls = false;
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
    this.sources = [...new Set([station.url_resolved, station.url].filter(url => /^https?:\/\//i.test(url)))];
    this.sourceIndex = 0;
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
    if (this.audio.volume === 0) {
      this.spectrum?.reset();
      this.snapshot.spectrum = undefined;
    }
    this.emit();
  }

  setVisualizing(enabled: boolean): void {
    this.visualizing = enabled;
    if (enabled && !this.spectrumTimer) {
      this.spectrumSampleTime = 0;
      this.spectrumTimer = setInterval(() => this.sampleSpectrum(), 50);
    } else if (!enabled && this.spectrumTimer) {
      clearInterval(this.spectrumTimer);
      this.spectrumTimer = null;
      this.spectrum?.reset();
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

  private async connect(generation: number, resolvedBackup?: { url: string; backup?: string; endsAt?: number }): Promise<void> {
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
      const rawUrl = this.sources[this.sourceIndex];
      if (!rawUrl) {
        this.fail(generation, attempt, '재생 주소가 없습니다.', false);
        return;
      }
      const source = resolvedBackup || await this.bridge.streamUrl(rawUrl);
      if (!this.current(generation, attempt)) return;
      if (typeof source !== 'string' && 'offAir' in source) {
        let message = '현재 방송 시간이 아닙니다.';
        if (source.nextAt) {
          const time = new Date(source.nextAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
          message = '다음 방송 ' + time;
        }
        this.disposeConnection();
        this.snapshot = { ...this.snapshot, status: 'offair', playing: false, error: message, spectrum: undefined };
        this.setMediaPlaybackState('paused');
        this.emit();
        return;
      }
      const proxiedUrl = typeof source === 'string' ? source : source.url;
      if (typeof source !== 'string' && source.endsAt) {
        // This physical output can switch to another language after the programme.
        this.scheduleEnd = setTimeout(() => {
          if (this.current(generation, attempt)) void this.play(station);
        }, Math.max(1, source.endsAt - Date.now()));
      }
      const isHls = this.detectedHls || station.hls === 1 || /\.m3u8(?:[?#]|$)/i.test(rawUrl);
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
          if (typeof source !== 'string' && 'backup' in source && source.backup && !resolvedBackup) {
            this.disposeConnection();
            void this.connect(generation, { url: source.backup, endsAt: source.endsAt });
            return;
          }
          const denied = broadcastDenial(data.response?.code);
          if (denied) {
            this.fail(generation, attempt, denied, false);
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            this.fail(generation, attempt, '오디오를 해석할 수 없습니다.');
          } else {
            this.fail(generation, attempt, /timeout/i.test(data.details) ? '방송 서버의 응답 시간이 초과됐습니다.' : '방송 연결이 끊겼습니다.');
          }
        });
        hls.attachMedia(this.audio);
      } else {
        if (isHls && !this.audio.canPlayType('application/vnd.apple.mpegurl')) {
          this.fail(generation, attempt, '이 환경에서 재생할 수 없는 방송 형식입니다.', false);
          return;
        }
        this.directSource = proxiedUrl;
        this.audio.src = proxiedUrl;
        this.audio.load();
        await this.beginPlayback(generation, attempt);
      }
    } catch (error) {
      if (!this.current(generation, attempt)) return;
      this.fail(generation, attempt, '방송에 연결할 수 없습니다.');
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
      if (this.directSource && !this.hls && error instanceof DOMException && error.name === 'NotSupportedError') {
        void this.inspectDirectFailure(generation, attempt);
        return;
      }
      const blocked = error instanceof DOMException && error.name === 'NotAllowedError';
      this.fail(generation, attempt, blocked
        ? '재생 버튼을 눌러 주세요.'
        : '방송을 재생할 수 없습니다.', !blocked, !blocked);
    }
  }

  private readonly onPlaying = (): void => {
    if (!this.active || this.destroyed || !this.snapshot.station) return;
    const stationId = this.snapshot.station.stationuuid;
    this.clearDeadline();
    if (!this.playingSince) this.playingSince = Date.now();
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
    if (this.directSource && (unsupported || this.audio.error?.code === 2)) {
      void this.inspectDirectFailure(this.generation, this.attempt);
      return;
    }
    this.fail(this.generation, this.attempt, unsupported
      ? '재생할 수 없는 주소 또는 오디오 형식입니다.'
      : '방송 서버에 연결할 수 없습니다.', !unsupported);
  };

  // HTMLMediaElement hides the HTTP status, and an extensionless playlist can
  // arrive in the directory as an MP3. Inspect only after a failed attempt.
  private async inspectDirectFailure(generation: number, attempt: number): Promise<void> {
    if (this.probe) return;
    const controller = new AbortController();
    this.probe = controller;
    let message = '재생할 수 없는 주소 또는 오디오 형식입니다.';
    let retry = this.audio.error?.code === 2;
    try {
      const response = await fetch(this.directSource, { signal: controller.signal });
      if (!this.current(generation, attempt)) return;
      const type = response.headers.get('content-type') || '';
      if (response.ok && /mpegurl/i.test(type) && Hls.isSupported() && !this.detectedHls) {
        this.disposeConnection();
        this.detectedHls = true;
        void this.connect(generation);
        return;
      }
      const reason = response.headers.get('X-Allradione-Error');
      const denied = broadcastDenial(response.status);
      if (denied) { message = denied; retry = false; }
      else if (reason === 'tls') message = '방송 서버의 보안 인증서를 확인할 수 없습니다.';
      else if (reason === 'dns') message = '방송 서버 주소를 찾을 수 없습니다.';
      else if (reason === 'timeout') { message = '방송 서버의 응답 시간이 초과됐습니다.'; retry = true; }
      else if (response.ok && /text\/html/i.test(type)) message = '이 주소는 방송 대신 웹페이지를 보냅니다.';
      else if (response.status >= 500) { message = '방송 서버에 연결할 수 없습니다.'; retry = true; }
    } catch { /* A browser without CORS access can only report its media error. */ }
    finally {
      controller.abort();
      if (this.probe === controller) this.probe = null;
    }
    if (this.current(generation, attempt)) this.fail(generation, attempt, message, retry);
  }

  private readonly onEnded = (): void => {
    if (this.active && !this.destroyed) this.fail(this.generation, this.attempt, '방송 송출이 중단됐습니다.');
  };

  private fail(generation: number, attempt: number, message: string, retry = true, allowAlternate = true): void {
    if (!this.current(generation, attempt)) return;
    if (this.playingSince && Date.now() - this.playingSince >= 30000) this.retryCount = 0;
    this.disposeConnection();
    // Directory redirects can expire while the broadcaster's original entry
    // point still issues fresh media URLs. Keep both within one retry budget.
    const alternate = allowAlternate && this.sourceIndex + 1 < this.sources.length;
    if ((retry || alternate) && this.retryCount < 2) {
      if (alternate) this.sourceIndex += 1;
      this.retryCount += 1;
      this.snapshot = { ...this.snapshot, playing: false, status: 'connecting', spectrum: undefined };
      this.emit();
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.current(generation)) void this.connect(generation);
      }, alternate ? 0 : this.retryCount * 1250);
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
      if (this.current(generation, attempt)) this.fail(generation, attempt, '방송 서버가 응답하지 않습니다.');
    }, 18000);
  }

  private clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
  }

  private disposeConnection(): void {
    this.active = false;
    this.playingSince = 0;
    this.directSource = '';
    this.detectedHls = false;
    this.probe?.abort();
    this.probe = null;
    if (this.scheduleEnd) clearTimeout(this.scheduleEnd);
    this.scheduleEnd = null;
    this.spectrum?.reset();
    this.spectrumSampleTime = 0;
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
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.15;
        this.frequencyData = new Float32Array(this.analyser.frequencyBinCount);
        this.timeData = new Float32Array(this.analyser.fftSize);
        this.spectrum = new RadioSpectrum(this.context.sampleRate, this.analyser.fftSize);
        this.source = this.context.createMediaElementSource(this.audio);
        this.source.connect(this.analyser);
        this.analyser.connect(this.context.destination);
      } catch {
        // Visualization is optional; an unavailable Web Audio API must not fail radio playback.
        this.analyser = null;
        this.frequencyData = null;
        this.timeData = null;
        this.spectrum = null;
      }
    }
    if (this.context?.state === 'suspended') {
      try { await this.context.resume(); } catch { /* Playback reports a user-gesture block separately. */ }
    }
  }

  private sampleSpectrum(): void {
    if (!this.visualizing || !this.snapshot.playing || !this.analyser || !this.frequencyData || !this.timeData || !this.spectrum) return;
    if (this.audio.volume === 0 || this.audio.muted) {
      this.spectrum.reset();
      if (this.snapshot.spectrum) {
        this.snapshot.spectrum = undefined;
        this.emit();
      }
      return;
    }
    this.analyser.getFloatFrequencyData(this.frequencyData);
    this.analyser.getFloatTimeDomainData(this.timeData);
    let sumSquares = 0;
    for (let index = 0; index < this.timeData.length; index += 1) sumSquares += this.timeData[index] ** 2;
    const rms = Math.sqrt(sumSquares / this.timeData.length);
    const now = performance.now();
    const elapsed = this.spectrumSampleTime ? now - this.spectrumSampleTime : 50;
    this.spectrumSampleTime = now;
    this.snapshot.spectrum = this.spectrum.process(this.frequencyData, rms, elapsed);
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
