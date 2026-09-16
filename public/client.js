import { BusPlayer } from './player.js';
const $ = id => document.getElementById(id);
let player, wakeLock;
async function fullscreen() { try { await document.documentElement.requestFullscreen(); } catch {} try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {} }
$('fullscreen').onclick = fullscreen;
document.addEventListener('visibilitychange', () => { if (!document.hidden && player) navigator.wakeLock?.request('screen').then(lock => { wakeLock = lock; }).catch(() => {}); });
$('join-form').onsubmit = async event => {
  event.preventDefault(); const seat = $('seat').value ? Number($('seat').value) : null; $('join-form').hidden = true;
  fullscreen();
  player = new BusPlayer($('video'), { role: 'client', seat,
    onConnection: value => {
      $('client-connection').textContent = value === 'connected' ? 'Подключено к ведущему' : value === 'removed' ? 'Отключено ведущим' : 'Подключение…';
      if (value !== 'connected') { $('overlay').hidden = false; $('client-title').textContent = value === 'removed' ? 'Устройство исключено' : 'Восстанавливаем связь'; }
      if (value === 'removed') { $('client-progress').hidden = true; $('client-note').textContent = 'Показ на этом устройстве завершён.'; }
    },
    onState: state => { $('client-connection').textContent = `Место ${state.seat} · Подключено к ведущему`; if (!state.track) { $('client-title').textContent = 'Вы на месте.'; $('client-note').textContent = 'Ждём ведущего. Оставьте эту страницу открытой.'; } if (state.phase !== 'playing') $('overlay').hidden = false; },
    onStatus: status => {
      const playing = status.status === 'playing'; $('overlay').hidden = playing; $('fullscreen').hidden = playing;
      $('client-progress').hidden = status.status !== 'loading'; $('progress').value = status.progress; $('progress-label').textContent = `${Math.round(status.progress)}%`;
      $('client-title').textContent = ({ loading: 'Готовим ваш экран…', ready: 'Готовы к запуску.', scheduled: 'Начинаем…', error: 'Нужна помощь ведущего', unlock: 'Верните страницу на экран', hidden: 'Показ приостановлен' })[status.status] || 'Ждём ведущего';
      $('client-note').textContent = status.status === 'loading' ? 'Видео полностью загружается на планшет. Это может занять несколько минут.' : 'Звук звучит из колонок автобуса. Всё остальное сделает ведущий.';
      if (!status.error) { $('client-error').hidden = true; }
    },
    onError: message => { $('overlay').hidden = false; $('client-error').hidden = false; $('client-error').textContent = message; }
  });
};
