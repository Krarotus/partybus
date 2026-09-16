import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createBusServer } from '../server.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'partybus-test-'));
  await writeFile(path.join(dir, 'Тест.mp4'), '0123456789');
  const bus = createBusServer({ mediaDir: dir, leadMs: 100 });
  await new Promise(resolve => bus.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${bus.server.address().port}`;
  t.after(async () => { await bus.close(); await rm(dir, { recursive: true, force: true }); });
  async function connect(role, seat) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin: base });
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'HELLO', role, seat }));
    return { ws, messages, send: message => ws.send(JSON.stringify(message)) };
  }
  const library = await (await fetch(base + '/api/library')).json();
  return { bus, base, connect, library };
}
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
test('30 clients: READY barrier, same timestamp, pause, seek, stale READY and disconnect', async t => {
  const { bus, connect, library } = await fixture(t);
  const admin = await connect('admin');
  const clients = await Promise.all(Array.from({ length: 30 }, (_, i) => connect('client', i + 1)));
  await until(() => bus.snapshot().clients.length === 30);
  admin.send({ type: 'PRELOAD', id: library[0].id });
  await until(() => bus.snapshot().generation);
  const generation = bus.snapshot().generation;
  admin.send({ type: 'PLAY' });
  await until(() => admin.messages.some(m => m.type === 'ERROR'));
  assert.equal(bus.snapshot().phase, 'loading');
  const ready = { type: 'STATUS', generation, ready: true, status: 'ready', duration: 60, progress: 100 };
  admin.send(ready); clients.forEach(c => c.send(ready));
  await until(() => bus.snapshot().clients.every(c => c.ready) && bus.snapshot().audio.ready);
  admin.send({ type: 'PLAY' });
  await until(() => clients.every(c => c.messages.some(m => m.phase === 'playing')));
  const starts = clients.map(c => c.messages.find(m => m.phase === 'playing').startAt);
  assert.equal(new Set(starts).size, 1);
  assert.ok(starts[0] > Date.now() - 500);
  admin.send({ type: 'PAUSE' }); await until(() => bus.snapshot().phase === 'paused');
  admin.send({ type: 'SEEK', position: 20 }); await until(() => bus.snapshot().phase === 'playing');
  assert.equal(bus.snapshot().position, 20);
  clients[0].ws.close(); await until(() => bus.snapshot().clients.length === 29);
  assert.equal(bus.snapshot().phase, 'paused');
  const replacement = await connect('client', 1); replacement.send(ready);
  await until(() => bus.snapshot().clients.length === 30 && bus.snapshot().clients.every(c => c.ready));
  admin.send({ type: 'PRELOAD', id: library[0].id }); await until(() => bus.snapshot().generation !== generation);
  replacement.send(ready); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(bus.snapshot().clients.find(c => c.seat === 1).ready, false);
});
test('HTTP media ranges and local assets', async t => {
  const { base, library } = await fixture(t, 1);
  assert.equal(library[0].title, 'Тест');
  const partial = await fetch(base + library[0].video, { headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), '2345');
  const suffix = await fetch(base + library[0].video, { headers: { Range: 'bytes=-3' } });
  assert.equal(await suffix.text(), '789');
  assert.equal((await fetch(base + library[0].video, { headers: { Range: 'bytes=100-' } })).status, 416);
  assert.equal((await fetch(base + '/media/..%5Cserver.js')).status, 404);
  assert.equal((await fetch(base + '/admin')).status, 200);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
});
test('client cannot control playback; duplicate seats and foreign origins rejected', async t => {
  const { bus, base, connect, library } = await fixture(t, 1);
  const client = await connect('client', 1);
  await until(() => bus.snapshot().clients.length === 1);
  client.send({ type: 'PRELOAD', id: library[0].id });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(bus.snapshot().track, null);
  const duplicate = await connect('client', 1);
  const code = await new Promise(resolve => duplicate.ws.once('close', resolve)); assert.equal(code, 1008);
  assert.equal(bus.snapshot().clients.length, 1);
  const foreign = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin: 'https://example.com' });
  const message = await new Promise(resolve => foreign.once('error', error => resolve(error.message)));
  assert.match(message, /403/);
});
test('duration mismatch and admin disconnect prevent unsafe playback', async t => {
  const { bus, connect, library } = await fixture(t, 1);
  const admin = await connect('admin'), client = await connect('client', 1);
  admin.send({ type: 'PRELOAD', id: library[0].id }); await until(() => bus.snapshot().generation);
  const ready = { type: 'STATUS', generation: bus.snapshot().generation, ready: true, status: 'ready', duration: 60 };
  admin.send(ready); client.send({ ...ready, duration: 40 });
  await until(() => bus.snapshot().audio.ready && bus.snapshot().clients[0]?.ready);
  admin.send({ type: 'PLAY' }); await until(() => admin.messages.some(m => m.type === 'ERROR'));
  assert.equal(bus.snapshot().phase, 'loading');
  client.send(ready); await until(() => bus.snapshot().clients[0].duration === 60);
  admin.send({ type: 'PLAY' }); await until(() => bus.snapshot().phase === 'playing');
  admin.ws.close(); await until(() => bus.snapshot().audio.status === 'offline');
  assert.equal(bus.snapshot().phase, 'paused');
});

test('dynamic roster: automatic seats beyond 30, sparse numbers, zero clients and late joins', async t => {
  const { bus, connect, library, base } = await fixture(t);
  const admin = await connect('admin');
  admin.send({ type: 'PRELOAD', id: library[0].id });
  await until(() => bus.snapshot().generation);
  const ready = { type: 'STATUS', generation: bus.snapshot().generation, ready: true, status: 'ready', duration: 60 };
  admin.send(ready); admin.send({ type: 'PLAY' });
  await until(() => admin.messages.some(m => m.type === 'ERROR'));
  assert.equal(bus.snapshot().phase, 'loading');
  const clients = await Promise.all(Array.from({ length: 35 }, () => connect('client')));
  await until(() => bus.snapshot().clients.length === 35);
  assert.equal(new Set(bus.snapshot().clients.map(c => c.seat)).size, 35);
  const sparse = await connect('client', 1000);
  await until(() => bus.snapshot().clients.length === 36);
  assert.ok(bus.snapshot().clients.some(c => c.seat === 1000));
  for (const client of clients) client.ws.close();
  await until(() => bus.snapshot().clients.length === 1);
  sparse.send(ready);
  await until(() => bus.snapshot().clients.every(c => c.ready));
  admin.send({ type: 'PLAY' });
  await until(() => bus.snapshot().phase === 'playing');
  const late = await connect('client');
  await until(() => bus.snapshot().clients.length === 2);
  assert.equal(bus.snapshot().phase, 'paused');
  const errors = admin.messages.filter(m => m.type === 'ERROR').length;
  admin.send({ type: 'PLAY' });
  await until(() => admin.messages.filter(m => m.type === 'ERROR').length > errors);
  late.send(ready); await until(() => bus.snapshot().clients.every(c => c.ready));
  admin.send({ type: 'PLAY' }); await until(() => bus.snapshot().phase === 'playing');
  const info = await (await fetch(base + '/api/info')).json();
  assert.equal(info.connected, 2); assert.equal('expected' in info, false);
});

test('QR endpoint serves PNGs for LAN addresses and rejects other destinations', async t => {
  const { base } = await fixture(t);
  const info = await (await fetch(base + '/api/info')).json();
  assert.equal((await fetch(base + '/api/qr?url=https://example.com')).status, 400);
  assert.equal((await fetch(base + '/api/qr')).status, 400);
  const images = [];
  for (const address of info.urls) {
    const response = await fetch(base + '/api/qr?url=' + encodeURIComponent(address));
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'image/png');
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(png.readUInt32BE(16) >= 300); assert.equal(png.readUInt32BE(16), png.readUInt32BE(20));
    images.push(png.toString('base64'));
  }
  assert.equal(new Set(images).size, info.urls.length);
});

test('only admin can exclude a connection; remaining ready clients can play', async t => {
  const { bus, connect, library } = await fixture(t);
  const admin = await connect('admin');
  const first = await connect('client', 1), second = await connect('client', 2), unready = await connect('client', 3);
  await until(() => bus.snapshot().clients.length === 3);
  const removedId = bus.snapshot().clients.find(c => c.seat === 3).id;
  first.send({ type: 'KICK', id: removedId });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(bus.snapshot().clients.length, 3);
  admin.send({ type: 'PRELOAD', id: library[0].id });
  await until(() => bus.snapshot().generation);
  const ready = { type: 'STATUS', generation: bus.snapshot().generation, ready: true, status: 'ready', duration: 60 };
  admin.send(ready); first.send(ready); second.send(ready);
  await until(() => bus.snapshot().audio.ready && bus.snapshot().clients.filter(c => c.ready).length === 2);
  const closed = new Promise(resolve => unready.ws.once('close', code => resolve(code)));
  admin.send({ type: 'KICK', id: removedId });
  assert.equal(await closed, 4001);
  await until(() => bus.snapshot().clients.length === 2);
  admin.send({ type: 'PLAY' }); await until(() => bus.snapshot().phase === 'playing');
  admin.send({ type: 'KICK', id: bus.snapshot().clients.find(c => c.seat === 1).id });
  await until(() => bus.snapshot().clients.length === 1);
  assert.equal(bus.snapshot().phase, 'playing');
  admin.send({ type: 'KICK', id: bus.snapshot().clients[0].id });
  await until(() => bus.snapshot().clients.length === 0);
  assert.equal(bus.snapshot().phase, 'paused');
  await connect('client', 3);
  await until(() => bus.snapshot().clients.length === 1);
  admin.send({ type: 'KICK', id: removedId });
  await until(() => admin.messages.some(m => m.type === 'ERROR'));
  assert.equal(bus.snapshot().clients[0].seat, 3);
});
