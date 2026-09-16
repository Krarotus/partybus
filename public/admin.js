import { BusPlayer, formatTime } from './player.js';
const $ = id => document.getElementById(id);
let library = [], selected = null, state = null, connected = false;
const names = { connected: 'Подключён', loading: 'Загрузка', ready: 'READY', playing: 'Показ', scheduled: 'Старт…', error: 'Ошибка', hidden: 'В фоне', buffering: 'Буферизация', unlock: 'Нужен клик' };
const error = message => { $('error').textContent = message; $('error').hidden = !message; };
const player = new BusPlayer($('audio'), { role: 'admin', onState: render, onError: error, onConnection: value => { connected = value === 'connected'; $('connection').textContent = connected ? '● Сервер подключён' : '○ Связь с сервером потеряна'; $('connection').classList.toggle('live', connected); updateControls(); }, onStatus: s => { $('unlock').disabled = !s.loaded || s.armed || state?.phase === 'playing'; } });
async function refresh() {
  try {
    const response = await fetch('/api/library'); if (!response.ok) throw new Error();
    library = await response.json(); $('count').textContent = library.length;
    if (!library.some(t => t.id === selected?.id)) selected = library[0] || null;
    drawLibrary(); updateControls();
  } catch { error('Не удалось прочитать медиатеку. Проверьте сервер и папку media.'); }
}
function drawLibrary() {
  $('library').replaceChildren();
  if (!library.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Здесь появятся ваши ролики. Скопируйте .mp4 или .webm в папку media и нажмите «Обновить».'; $('library').append(empty); }
  library.forEach((track, index) => {
    const button = document.createElement('button'); button.className = `track ${track.id === selected?.id ? 'selected' : ''}`;
    const number = document.createElement('span'); number.className = 'track-number'; number.textContent = String(index + 1).padStart(2, '0');
    const text = document.createElement('span'); const title = document.createElement('strong'); title.textContent = track.title;
    const detail = document.createElement('small'); detail.textContent = `${(track.bytes / 1024 / 1024).toFixed(1)} МБ · ${track.separateAudio ? 'отдельное аудио' : 'аудиодорожка видео'}`;
    text.append(title, detail); button.append(number, text); button.onclick = () => { selected = track; drawLibrary(); updateControls(); }; $('library').append(button);
  });
  $('track-title').textContent = state?.track?.title || selected?.title || 'Начнём с видео';
}
function updateControls() {
  const ready = connected && state?.track && state.clients.length > 0 && state.clients.every(c => c.ready) && state.audio.ready;
  $('play').disabled = !ready || state?.phase === 'playing';
  for (const id of ['back', 'forward', 'seek']) $(id).disabled = !ready;
  $('preload').disabled = !connected || !selected;
  $('preload').textContent = selected && state?.track && selected.id !== state.track.id ? `↓ Загрузить: ${selected.title}` : '↓ Загрузить на планшеты';
  $('pause').disabled = !connected || state?.phase !== 'playing'; $('stop').disabled = !connected || !state?.track;
}
function render(s) {
  state = s; const ready = s.clients.filter(c => c.ready).length;
  $('online').textContent = s.clients.length; $('ready').textContent = ready; $('ready-total').textContent = ` / ${s.clients.length}`;
  $('ready-note').textContent = !s.clients.length ? 'Подключите устройства по ссылке или QR-коду' : ready === s.clients.length ? 'Все планшеты подготовлены' : `Ожидаем ещё ${s.clients.length - ready} устройств`;
  $('audio-label').textContent = s.audio.ready ? 'Готово' : names[s.audio.status] || 'Не готово';
  $('audio-label').classList.toggle('green', s.audio.ready);
  $('phase').textContent = { idle: 'ОЖИДАНИЕ', loading: 'ПОДГОТОВКА', paused: 'ПАУЗА', playing: 'ВОСПРОИЗВЕДЕНИЕ' }[s.phase];
  $('track-title').textContent = s.track?.title || selected?.title || 'Начнём с видео';
  $('stage-note').textContent = s.track ? `${ready} из ${s.clients.length} экранов готовы · запуск с отсчётом 2 секунды` : 'Добавьте MP4 в медиатеку и выберите его слева';
  $('start-hint').textContent = !s.audio.ready && s.audio.progress === 100 ? 'Аудио загружено. Нажмите «Разрешить звук» на ноутбуке.' : 'Старт доступен после готовности всех устройств и аудио.';
  $('duration').textContent = formatTime(s.duration); $('seek').max = s.duration || 1;
  $('devices').replaceChildren();
  if (!s.clients.length) { const empty = document.createElement('p'); empty.className = 'devices-empty muted'; empty.textContent = 'Пока никто не подключился. Нажмите на IP-адрес внизу, чтобы показать QR-код.'; $('devices').append(empty); }
  for (const c of [...s.clients].sort((a, b) => a.seat - b.seat)) {
    const seat = c.seat; const card = document.createElement('div'); card.className = `device ${c.ready ? 'is-ready' : 'is-loading'}`;
    const num = document.createElement('strong'); num.textContent = String(seat).padStart(2, '0');
    const label = document.createElement('span'); label.textContent = c ? (c.status === 'loading' ? `${Math.round(c.progress)}%` : names[c.status] || c.status) : 'Не в сети';
    const detail = document.createElement('small'); detail.textContent = c?.ready ? `${c.drift || 0} мс` : c?.error ? 'Требует внимания' : 'Планшет';
    const remove = document.createElement('button'); remove.className = 'device-remove'; remove.textContent = 'Исключить';
    remove.setAttribute('aria-label', `Исключить устройство ${seat}`); remove.disabled = !connected;
    remove.onclick = () => { remove.disabled = true; command('KICK', { id: c.id }); };
    card.title = c?.error || `Место ${seat}`; card.append(num, label, detail, remove); $('devices').append(card);
  }
  updateControls();
}
function command(type, data = {}) { error(''); player.send({ type, ...data }); }
$('refresh').onclick = refresh;
$('preload').onclick = () => command('PRELOAD', { id: selected.id });
$('unlock').onclick = () => player.unlockAudio();
$('play').onclick = () => command('PLAY'); $('pause').onclick = () => command('PAUSE'); $('stop').onclick = () => command('STOP');
$('back').onclick = () => command('SEEK', { position: player.target() - 10 }); $('forward').onclick = () => command('SEEK', { position: player.target() + 10 });
$('seek').onchange = () => command('SEEK', { position: Number($('seek').value) });
setInterval(() => { if (!state) return; const t = state.track ? player.target() : 0; $('time').textContent = formatTime(t); if (document.activeElement !== $('seek')) $('seek').value = t; if (state.phase === 'playing' && state.startAt > player.serverTime()) $('phase').textContent = `СТАРТ ЧЕРЕЗ ${Math.ceil((state.startAt - player.serverTime()) / 1000)}…`; }, 100);
function showQR(url) {
  $('qr-url').textContent = url; $('qr-url').href = url;
  $('qr-status').textContent = 'Создаём QR-код…'; $('qr-image').hidden = true;
  $('qr-image').onload = () => { $('qr-status').textContent = ''; $('qr-image').hidden = false; };
  $('qr-image').onerror = () => { $('qr-status').textContent = 'Не удалось загрузить QR-код. Обновите пульт и попробуйте снова.'; };
  $('qr-image').src = `/api/qr?url=${encodeURIComponent(url)}`;
  $('qr-dialog').showModal();
}
$('qr-close').onclick = () => $('qr-dialog').close();
$('qr-dialog').addEventListener('click', event => { const box = $('qr-dialog').getBoundingClientRect(); if (event.target === $('qr-dialog') && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) $('qr-dialog').close(); });
fetch('/api/info').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(info => {
  $('addresses').replaceChildren();
  for (const url of info.urls) { const button = document.createElement('button'); button.className = 'address-button'; button.textContent = `${url} · QR-код`; button.onclick = () => showQR(url); $('addresses').append(button); }
  if (!info.urls.length) $('addresses').textContent = 'Подключите ноутбук к Wi-Fi';
}).catch(() => { $('addresses').textContent = 'Не удалось получить адреса. Обновите страницу.'; });
refresh();
