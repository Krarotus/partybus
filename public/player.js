const clock = () => performance.timeOrigin + performance.now();
export class BusPlayer {
  constructor(media, { role, seat, onState = () => {}, onStatus = () => {}, onConnection = () => {}, onError = () => {} }) {
    Object.assign(this, { media, role, seat, onState, onStatus, onConnection, onError });
    this.samples = []; this.offset = 0; this.generation = null; this.ready = false; this.loaded = false; this.armed = role === 'client'; this.revision = -1;
    media.muted = role === 'client'; media.preload = 'auto';
    media.addEventListener('error', () => { if (this.loaded) this.fail('Браузер не смог декодировать файл.'); });
    media.addEventListener('waiting', () => { if (this.ready && this.state?.phase === 'playing' && media.currentTime > 0) this.report('buffering'); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.cancelStart(); media.pause(); this.ready = false; this.report('hidden', 'Верните страницу на экран.'); }
      else if (this.loaded && this.armed) { this.ready = true; this.revision = -1; this.report('ready'); this.apply(); }
    });
    this.connect();
    this.syncInterval = setInterval(() => this.sync(), 2000);
    this.driftInterval = setInterval(() => this.correct(), 1000);
  }
  serverTime() { return clock() + this.offset; }
  send(data) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data)); }
  connect() {
    this.onConnection('connecting');
    this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    this.ws.onopen = () => {
      this.samples = []; this.revision = -1;
      this.send({ type: 'HELLO', role: this.role, seat: this.seat });
      this.onConnection('connected');
      for (let n = 0; n < 5; n++) setTimeout(() => this.sync(), n * 120);
    };
    this.ws.onmessage = event => {
      const m = JSON.parse(event.data);
      if (m.type === 'SYNC') {
        const rtt = clock() - m.sent;
        if (rtt < 1500 && rtt >= 0) {
          this.samples.push({ rtt, offset: m.serverNow - (m.sent + clock()) / 2 });
          this.samples = this.samples.slice(-15);
          this.offset = [...this.samples].sort((a, b) => a.rtt - b.rtt)[0].offset;
          if (this.samples.length === 3) { this.report(this.ready ? 'ready' : this.generation ? (this.loaded ? 'unlock' : 'loading') : 'connected'); this.apply(); }
        }
      } else if (m.type === 'STATE') {
        if (m.seat) this.seat = m.seat;
        this.state = m; this.onState(m);
        if (m.generation && m.generation !== this.generation) this.load(m);
        else this.apply();
      } else if (m.type === 'ERROR') this.onError(m.message);
    };
    this.ws.onclose = event => {
      this.cancelStart(); this.media.pause(); this.revision = -1; this.onConnection(event.code === 4001 ? 'removed' : 'offline');
      if (event.code === 4001) {
        this.generation = null; this.ready = false; this.loaded = false;
        this.abort?.abort(); clearInterval(this.syncInterval); clearInterval(this.driftInterval);
        this.media.removeAttribute('src'); this.media.load();
        if (this.blobURL) { URL.revokeObjectURL(this.blobURL); this.blobURL = null; }
        this.onError('Ведущий исключил это устройство. Для повторного подключения обновите страницу.'); return;
      }
      if (event.code === 1008) { this.onError(this.role === 'client' ? 'Это место уже занято или недоступно. Выберите другое место и перезагрузите страницу.' : 'Пульт уже открыт в другой вкладке. Закройте её и обновите страницу.'); return; }
      setTimeout(() => this.connect(), 1500);
    };
  }
  sync() { this.send({ type: 'SYNC', sent: clock() }); }
  report(status, error = '') {
    this.status = status;
    const data = { type: 'STATUS', generation: this.generation, ready: this.ready && this.samples.length >= 3 && !document.hidden, status, error, duration: this.media.duration || 0, progress: this.progress || 0, drift: this.drift || 0 };
    this.send(data); this.onStatus({ ...data, loaded: this.loaded, armed: this.armed });
  }
  fail(message) { this.ready = false; this.cancelStart(); this.media.pause(); this.report('error', message); this.onError(message); }
  cancelStart() { clearTimeout(this.startTimer); this.startTimer = null; }
  async load(state) {
    this.cancelStart(); this.abort?.abort(); this.abort = new AbortController();
    const signal = this.abort.signal;
    this.generation = state.generation; this.ready = false; this.loaded = false; this.progress = 0; this.revision = -1;
    this.media.pause(); this.media.removeAttribute('src'); this.media.load();
    if (this.blobURL) URL.revokeObjectURL(this.blobURL);
    this.report('loading');
    let timeout = setTimeout(() => this.abort.abort(), 10 * 60 * 1000);
    try {
      const url = this.role === 'admin' ? state.track.audio : state.track.video;
      const response = await fetch(`${url}?v=${encodeURIComponent(state.track.version)}`, { signal });
      if (!response.ok) throw new Error(`Ошибка загрузки: HTTP ${response.status}`);
      const size = Number(response.headers.get('Content-Length'));
      const reader = response.body.getReader(); const chunks = []; let bytes = 0, lastReport = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        chunks.push(value); bytes += value.length; this.progress = size ? Math.min(99, bytes / size * 100) : 0;
        if (clock() - lastReport > 500) { this.report('loading'); lastReport = clock(); }
      }
      if (signal.aborted) return;
      clearTimeout(timeout);
      const blob = new Blob(chunks, { type: response.headers.get('Content-Type') || 'video/mp4' });
      chunks.length = 0;
      this.blobURL = URL.createObjectURL(blob);
      await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); this.media.removeEventListener('canplay', ok); this.media.removeEventListener('error', bad); signal.removeEventListener('abort', canceled); };
        const ok = () => { cleanup(); resolve(); };
        const bad = () => { cleanup(); reject(new Error('Формат не поддерживается. Используйте MP4 H.264 / AAC.')); };
        const canceled = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Подготовка файла заняла больше 30 секунд.')); }, 30000);
        this.media.addEventListener('canplay', ok, { once: true }); this.media.addEventListener('error', bad, { once: true }); signal.addEventListener('abort', canceled, { once: true });
        this.media.src = this.blobURL; this.media.load();
      });
      if (signal.aborted) return;
      if (!Number.isFinite(this.media.duration) || this.media.duration <= 0) throw new Error('Не удалось определить длительность ролика.');
      this.loaded = true; this.progress = 100;
      if (this.role === 'client') {
        await this.media.play(); if (signal.aborted) return;
        this.media.pause(); this.media.currentTime = 0;
      }
      this.ready = this.armed && !document.hidden;
      this.report(this.ready ? 'ready' : 'unlock'); this.apply();
    } catch (error) {
      if (this.generation === state.generation) this.fail(error.name === 'AbortError' ? 'Загрузка прервана или превышено время ожидания. Повторите предзагрузку.' : error.message);
    } finally { clearTimeout(timeout); }
  }
  async unlockAudio() {
    if (!this.loaded) return;
    const volume = this.media.volume; this.media.volume = 0;
    try {
      await this.media.play(); this.media.pause(); this.media.currentTime = 0;
      this.armed = true; this.ready = !document.hidden; this.report('ready');
    } catch { this.fail('Нажмите «Разрешить звук» ещё раз. Проверьте настройки браузера.'); }
    finally { this.media.volume = volume; }
  }
  target() { return Math.min(this.media.duration || Infinity, this.state.position + (this.state.phase === 'playing' ? Math.max(0, (this.serverTime() - this.state.startAt) / 1000) : 0)); }
  apply() {
    const s = this.state;
    if (!s || !this.ready || this.samples.length < 3 || this.generation !== s.generation || this.revision === s.revision) return;
    this.revision = s.revision; this.cancelStart(); this.media.pause(); this.media.playbackRate = 1;
    this.media.currentTime = this.target();
    if (s.phase !== 'playing') { this.report('ready'); return; }
    const revision = s.revision;
    const play = async () => {
      if (!this.ready || document.hidden || this.state.revision !== revision || this.ws.readyState !== WebSocket.OPEN) return;
      const remaining = s.startAt - this.serverTime();
      if (remaining > 8) { this.startTimer = setTimeout(play, remaining); return; }
      const target = this.target();
      if (Math.abs(this.media.currentTime - target) > 0.08) this.media.currentTime = target;
      try { await this.media.play(); this.report('playing'); }
      catch { if (this.state.revision === revision) this.fail('Воспроизведение заблокировано браузером. Нужен повторный вход или разрешение звука.'); }
    };
    this.report('scheduled'); this.startTimer = setTimeout(play, Math.max(0, s.startAt - this.serverTime()));
  }
  correct() {
    if (!this.ready || this.state?.phase !== 'playing' || this.serverTime() < this.state.startAt || this.media.paused) return;
    const delta = this.target() - this.media.currentTime; this.drift = Math.round(delta * 1000);
    if (Math.abs(delta) > 0.3) { this.media.currentTime = this.target(); this.media.playbackRate = 1; }
    else this.media.playbackRate = Math.abs(delta) > 0.06 ? (delta > 0 ? 1.02 : 0.98) : 1;
    this.report('playing');
  }
}
export function formatTime(value) { const n = Math.max(0, Math.floor(value || 0)); return `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`; }
