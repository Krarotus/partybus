import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';

const root = path.dirname(fileURLToPath(import.meta.url));
const now = () => performance.timeOrigin + performance.now();
const local = ip => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav' };

export function createBusServer({ mediaDir = path.join(root, 'media'), leadMs = 2000 } = {}) {
  const peers = new Map();
  const seats = new Map();
  let admin = null;
  let catalog = [];
  let state = { revision: 0, generation: null, track: null, phase: 'idle', position: 0, startAt: null, duration: 0 };
  const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  const position = () => Math.min(state.duration || Infinity, state.position + (state.phase === 'playing' ? Math.max(0, (now() - state.startAt) / 1000) : 0));
  const snapshot = () => ({ type: 'STATE', ...state, serverNow: now(), clients: [...seats.values()].map(p => ({ id: p.id, seat: p.seat, ...p.status })), audio: admin?.status ?? { ready: false, status: 'offline' } });
  const addresses = () => Object.values(networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${server.address().port}`);
  const broadcast = (adminOnly = false) => {
    const data = snapshot();
    for (const [ws, p] of peers) {
      if (p.role === 'admin') send(ws, data);
      else if (p.role && !adminOnly) send(ws, { type: 'STATE', ...state, serverNow: now(), seat: p.seat });
    }
  };
  function change(patch) { state = { ...state, ...patch, revision: state.revision + 1 }; broadcast(); }
  function pause() { change({ position: position(), phase: state.track ? 'paused' : 'idle', startAt: null }); }
  async function files() {
    const entries = await readdir(mediaDir, { withFileTypes: true });
    const names = new Set(entries.filter(e => e.isFile()).map(e => e.name));
    const result = [];
    for (const name of [...names].sort()) {
      if (!/\.(mp4|webm)$/i.test(name)) continue;
      const info = await stat(path.join(mediaDir, name));
      const stem = name.replace(/\.[^.]+$/, '');
      const audio = ['.mp3', '.m4a', '.wav'].map(ext => stem + ext).find(n => names.has(n));
      result.push({ id: name, title: stem, bytes: info.size, version: `${info.size}-${info.mtimeMs}`, video: `/media/${encodeURIComponent(name)}`, audio: `/media/${encodeURIComponent(audio || name)}`, separateAudio: !!audio });
    }
    return result;
  }
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'");
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/library') {
        catalog = await files(); res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(catalog)); return;
      }
      if (url.pathname === '/api/info') {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ connected: seats.size, urls: addresses() })); return;
      }
      if (url.pathname === '/api/qr') {
        const target = url.searchParams.get('url');
        if (!addresses().includes(target)) { res.writeHead(400).end('Unknown tablet address'); return; }
        const png = await QRCode.toBuffer(target, { type: 'png', width: 360, margin: 4, errorCorrectionLevel: 'M' });
        res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'no-store'); res.end(png); return;
      }
      let file;
      if (url.pathname.startsWith('/media/')) {
        const name = decodeURIComponent(url.pathname.slice(7));
        if (!name || name !== path.basename(name) || /[\\/\0:]/.test(name) || !types[path.extname(name).toLowerCase()]) { res.writeHead(404).end(); return; }
        file = await realpath(path.join(mediaDir, name));
        if (path.dirname(file) !== await realpath(mediaDir)) { res.writeHead(403).end(); return; }
      } else {
        const routes = { '/': 'client.html', '/admin': 'admin.html', '/style.css': 'style.css', '/client.js': 'client.js', '/admin.js': 'admin.js', '/player.js': 'player.js' };
        const name = routes[url.pathname];
        if (!name) { res.writeHead(404).end(); return; }
        if (url.pathname === '/admin' && !local(req.socket.remoteAddress)) { res.writeHead(403).end('Open admin on the laptop at localhost.'); return; }
        file = path.join(root, 'public', name);
      }
      const info = await stat(file);
      if (!info.isFile()) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', types[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Accept-Ranges', 'bytes');
      let start = 0, end = info.size - 1;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
        start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
        if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
        res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      }
      res.setHeader('Content-Length', Math.max(0, end - start + 1));
      if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
      const stream = createReadStream(file, { start, end });
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
    } catch (error) { if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end('Cannot read file'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  server.on('upgrade', (req, socket, head) => {
    let originOK = false;
    try { originOK = new URL(req.headers.origin).host === req.headers.host; } catch {}
    if (req.url !== '/ws' || !originOK) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    const p = { id: randomUUID(), role: null, seat: null, alive: true, removed: false, status: { ready: false, status: 'connected', progress: 0 } };
    peers.set(ws, p);
    ws.on('pong', () => { p.alive = true; });
    const helloTimeout = setTimeout(() => { if (!p.role) ws.close(1008, 'HELLO required'); }, 5000);
    ws.on('message', raw => {
      if (p.removed) return;
      try {
        const m = JSON.parse(raw);
        if (!m || typeof m !== 'object') return;
        if (m.type === 'SYNC') { send(ws, { type: 'SYNC', sent: m.sent, serverNow: now() }); return; }
        if (m.type === 'HELLO' && !p.role) {
          if (m.role === 'admin') {
            if (!local(req.socket.remoteAddress) || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host) || admin) { ws.close(1008, 'Admin unavailable or not local'); return; }
            p.role = 'admin'; admin = p;
          } else if (m.role === 'client') {
            let seat = m.seat;
            if (seat == null) { seat = 1; while (seats.has(seat)) seat++; }
            if (!Number.isSafeInteger(seat) || seat < 1 || seats.has(seat)) { ws.close(1008, 'Seat unavailable'); return; }
            p.role = 'client'; p.seat = seat; seats.set(seat, p);
            if (state.phase === 'playing') pause();
          } else { ws.close(1008, 'Seat unavailable'); return; }
          clearTimeout(helloTimeout); broadcast(); return;
        }
        if (!p.role) return;
        if (m.type === 'STATUS' && m.generation === state.generation) {
          const duration = Number(m.duration);
          const wasReady = p.status.ready;
          p.status = { ready: m.ready === true && Number.isFinite(duration) && duration > 0, status: String(m.status || '').slice(0, 80), progress: Math.max(0, Math.min(100, Number(m.progress) || 0)), error: String(m.error || '').slice(0, 180), drift: Math.max(-99999, Math.min(99999, Number(m.drift) || 0)), duration };
          if (p.role === 'admin' && p.status.ready && !state.duration) state.duration = duration;
          if (wasReady && !p.status.ready && state.phase === 'playing') pause();
          broadcast(true); return;
        }
        if (p.role !== 'admin') return;
        if (m.type === 'KICK') {
          const target = [...peers].find(([, peer]) => peer.role === 'client' && !peer.removed && peer.id === m.id);
          if (!target) throw new Error('Это устройство уже отключено.');
          const [socket, peer] = target;
          peer.removed = true;
          if (seats.get(peer.seat) === peer) seats.delete(peer.seat);
          socket.close(4001, 'Removed by host');
          if (state.phase === 'playing' && seats.size === 0) pause(); else broadcast();
        } else if (m.type === 'PRELOAD') {
          const track = catalog.find(t => t.id === m.id);
          if (!track) throw new Error('Ролик не найден. Обновите медиатеку.');
          for (const peer of peers.values()) peer.status = { ready: false, status: 'loading', progress: 0 };
          change({ generation: randomUUID(), track, phase: 'loading', position: 0, startAt: null, duration: 0 });
        } else if (m.type === 'PLAY' || m.type === 'SEEK') {
          if (!state.track || seats.size === 0 || !admin.status.ready || [...seats.values()].some(c => !c.status.ready)) throw new Error('Подключите хотя бы одно устройство и дождитесь READY всех подключённых устройств и аудио.');
          const durations = [...seats.values()].map(c => c.status.duration).concat(admin.status.duration);
          if (Math.max(...durations) - Math.min(...durations) > 1) throw new Error('Длительность видео и аудио различается более чем на 1 секунду.');
          let target = m.type === 'SEEK' ? Number(m.position) : position();
          if (!Number.isFinite(target)) throw new Error('Некорректная позиция.');
          target = Math.max(0, Math.min(state.duration, target));
          if (target >= state.duration) target = 0;
          change({ phase: 'playing', position: target, startAt: now() + leadMs });
        } else if (m.type === 'PAUSE') pause();
        else if (m.type === 'STOP') change({ phase: state.track ? 'paused' : 'idle', position: 0, startAt: null });
      } catch (error) { send(ws, { type: 'ERROR', message: error instanceof SyntaxError ? 'Invalid JSON' : error.message }); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(helloTimeout); peers.delete(ws);
      if (p.role === 'client' && seats.get(p.seat) === p) seats.delete(p.seat);
      if (p === admin) admin = null;
      if (state.phase === 'playing' && p.role && !p.removed) pause(); else broadcast();
    });
  });
  const tick = setInterval(() => {
    if (state.phase === 'playing' && state.duration && position() >= state.duration) change({ phase: 'paused', position: state.duration, startAt: null });
    else broadcast();
  }, 1000);
  const heartbeat = setInterval(() => { for (const [ws, p] of peers) { if (!p.alive) ws.terminate(); else { p.alive = false; ws.ping(); } } }, 5000);
  return { server, snapshot, async close() { clearInterval(tick); clearInterval(heartbeat); for (const ws of peers.keys()) ws.terminate(); await new Promise(resolve => wss.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const bus = createBusServer();
  bus.server.listen(port, '0.0.0.0', () => {
    console.log(`Partybus: http://localhost:${port}/admin`);
    for (const i of Object.values(networkInterfaces()).flat()) if (i.family === 'IPv4' && !i.internal) console.log(`Tablets: http://${i.address}:${port}`);
  });
  bus.server.on('error', error => { console.error(error.message); process.exit(1); });
  process.on('SIGINT', async () => { await bus.close(); process.exit(0); });
}
