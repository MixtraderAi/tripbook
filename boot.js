/* Trip app loader (PWA and APK).
   Unlocks the encrypted trip data with the PIN, starts the dashboard from the phone's copy without waiting
   for the network, then checks the mirrors and the weather models in the background.
   tools/build_pwa.py fills CONFIG and WX between the markers; the dashboard script itself is untouched. */
(() => {
'use strict';

const CONFIG = /*CONFIG*/{"DATA_ENDPOINTS": ["./data.json", "https://tripbook-five.vercel.app/data.json", "https://mixtraderai.github.io/tripbook/data.json"], "FETCH_TIMEOUT_MS": 3500, "WEATHER_TIMEOUT_MS": 15000, "LINK_SECRET": null, "BUILD": "41d3407a6b"}/*END*/;
const WX = /*WX*/{"cities": {"tyumen": [57.15, 65.53], "petro": [54.87, 69.15], "karaganda": [49.8, 73.1], "almaty": [43.24, 76.89], "xian": [34.34, 108.94], "chengdu": [30.66, 104.06]}, "models": {"ecmwf": "ecmwf_ifs025", "gfs": "gfs_seamless", "icon": "icon_seamless", "cma": "cma_grapes_global", "jma": "jma_seamless"}}/*END*/;

const readJSON = id => { const el = document.getElementById(id); if (!el) return null; try { return JSON.parse(el.textContent); } catch (e) { return null; } };
// encrypted snapshot baked into the APK build, so the first launch works in a plane without internet
const FALLBACK_ENCRYPTED_DATA = readJSON('pwa-fallback');

const LS = {
  get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  del: k => { try { localStorage.removeItem(k); } catch (e) {} }
};
const K_PIN = 'trip_pin', K_SECRET = 'trip_secret', K_CHECKED = 'trip_checked_at', K_WX = 'weather_cache';

/* ---------- Web Crypto: AES-256-GCM, key from PBKDF2-SHA256 ---------- */
const CryptoEngine = {
  keys: new Map(),
  base64ToBuf(b64) {
    const bin = atob(b64), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
  async deriveKey(password, saltB64, iterations) {
    const id = saltB64 + '|' + iterations + '|' + password;
    if (this.keys.has(id)) return this.keys.get(id);
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), {name: 'PBKDF2'}, false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      {name: 'PBKDF2', salt: this.base64ToBuf(saltB64), iterations, hash: 'SHA-256'},
      material, {name: 'AES-GCM', length: 256}, false, ['decrypt']);
    this.keys.set(id, key);
    return key;
  },
  async decryptPayload(enc, password) {
    const key = await this.deriveKey(password, enc.salt, enc.iter || 100000);  // payloads before "iter" used 100 000
    const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: this.base64ToBuf(enc.iv)}, key, this.base64ToBuf(enc.cipher));
    if (!enc.gz) return JSON.parse(new TextDecoder().decode(plain));
    const text = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return JSON.parse(text);
  }
};
const isWrongPin = err => err && err.name === 'OperationError';

/* ---------- the phone's copy: IndexedDB (the ticket files do not fit into localStorage) ---------- */
const DB = {
  conn: null,
  open() {
    if (!this.conn) this.conn = new Promise((res, rej) => {
      const r = indexedDB.open('trip-pwa', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this.conn;
  },
  async get(key) {
    const db = await this.open();
    return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  },
  async put(entries) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite'), st = tx.objectStore('kv');
      Object.entries(entries).forEach(([k, v]) => v === undefined ? st.delete(k) : st.put(v, k));
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  }
};
const dbGet = k => DB.get(k).catch(() => null);
const dbPut = e => DB.put(e).catch(() => {});

/* ---------- mirrors: Vercel, GitHub Pages, this host ---------- */
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // no-cache = always ask the server, but a 304 costs a few bytes on roaming instead of the whole file
    const res = await fetch(url, {cache: 'no-cache', mode: 'cors', signal: controller.signal});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(id); }
}
const endpoints = () => [...new Set(CONFIG.DATA_ENDPOINTS
  .filter(u => u && !u.includes('ЗАМЕНИТЬ_НА_'))
  .map(u => { try { return new URL(u, location.href).href; } catch (e) { return null; } })
  .filter(Boolean))];
const validData = p => p && p.cipher && p.salt && p.iv && p.updatedAt;

// all mirrors at once; the newest copy wins, so a mirror that was not redeployed cannot roll the data back
async function fetchLatestEncryptedData() {
  const got = await Promise.allSettled(endpoints().map(u => fetchWithTimeout(u, CONFIG.FETCH_TIMEOUT_MS).then(p => ({p, url: u}))));
  const ok = got.filter(r => r.status === 'fulfilled' && validData(r.value.p)).map(r => r.value);
  if (!ok.length) throw new Error('Все узлы обновления недоступны');
  ok.sort((a, b) => String(b.p.updatedAt).localeCompare(String(a.p.updatedAt)));
  return ok[0];
}
async function fetchFiles(dataUrl, hash) {
  const urls = [dataUrl].concat(endpoints().filter(u => u !== dataUrl)).map(u => new URL('files.json', u).href);
  for (const u of urls) {
    try { const p = await fetchWithTimeout(u, CONFIG.FETCH_TIMEOUT_MS * 4); if (p && p.cipher && p.hash === hash) return p; }
    catch (e) { console.warn('Узел ' + u + ' недоступен, пробуем следующий...'); }
  }
  throw new Error('Файлы билетов не загрузились');
}

/* ---------- PIN and the link secret ---------- */
function takeSecretFromLink(text) {
  const m = String(text).match(/(?:#|&|^)k=([A-Za-z0-9_-]{16,})/);
  if (!m) return false;
  LS.set(K_SECRET, m[1]);
  return true;
}
const secret = () => CONFIG.LINK_SECRET || LS.get(K_SECRET);
const password = pin => secret() + '.' + pin;
if (takeSecretFromLink(location.hash)) {
  // the secret must not stay in the address bar, history or a shared screenshot
  const rest = location.hash.slice(1).split('&').filter(p => !p.startsWith('k=')).join('&');
  history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
}

/* ---------- weather: the same five models as tools/weather.py, the CMA forecast stays from the last build ---------- */
const median = xs => { const s = xs.slice().sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const r1 = x => Math.round(x * 10) / 10;
const pad = n => String(n).padStart(2, '0');
const isoMin = t => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const hhmm = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const ddmmhhmm = t => { const d = new Date(t); return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' + hhmm(t); };
function weatherCache() { try { return JSON.parse(LS.get(K_WX) || 'null'); } catch (e) { return null; } }

let tripDays = [];  // [{city, date}] from the trip data, set at start
async function refreshWeather() {
  const models = Object.entries(WX.models);
  const old = weatherCache();
  if (!models.length || (old && Date.now() - old.at < 30 * 60000)) return false;
  // only the cities the trip still visits within the 16-day forecast window, one request per city as in weather.py
  const from = isoMin(Date.now()).slice(0, 10), to = isoMin(Date.now() + 15 * 86400000).slice(0, 10);
  const keys = [...new Set(tripDays.filter(d => d.date >= from && d.date <= to).map(d => d.city))].filter(k => WX.cities[k]);
  if (!keys.length) return false;
  const got = await Promise.allSettled(keys.map(k => fetchWithTimeout('https://api.open-meteo.com/v1/forecast?latitude=' + WX.cities[k][0] +
    '&longitude=' + WX.cities[k][1] + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&models=' +
    models.map(m => m[1]).join(',') + '&forecast_days=16&timezone=auto', CONFIG.WEATHER_TIMEOUT_MS)));
  const days = old ? old.days : {};
  let fresh = 0;
  keys.forEach((k, i) => {
    const f = got[i].status === 'fulfilled' && got[i].value.daily; if (!f) return;
    days[k] = {};
    f.time.forEach((t, j) => {
      const per = {};
      models.forEach(([short, m]) => {
        const tx = (f['temperature_2m_max_' + m] || [])[j], tn = (f['temperature_2m_min_' + m] || [])[j];
        if (tx != null && tn != null) per[short] = {tmax: tx, tmin: tn, p: (f['precipitation_probability_max_' + m] || [])[j]};
      });
      if (Object.keys(per).length) days[k][t] = per;
    });
    fresh++;
  });
  if (!fresh) return false;
  LS.set(K_WX, JSON.stringify({at: Date.now(), days}));
  return !old || Date.now() - old.at > 3 * 3600000;
}

// rewrites row.fc the way tools/weather.py builds it: median of the models (+ CMA), spread of the maxima
function applyWeather(state) {
  const c = weatherCache(), W = state && state.weather;
  if (!c || !W || !Array.isArray(W.days)) return;
  const at = isoMin(c.at);
  if (W.updated && W.updated >= at) return;  // the son's build is fresher than the phone's last check
  let used = false;
  W.days.forEach(row => {
    const per = c.days[row.city] && c.days[row.city][row.date];
    if (!per) return;
    const loc = row.fc && row.fc.local, v = Object.values(per);
    const mx = v.map(x => x.tmax).concat(loc && loc.tmax != null ? [loc.tmax] : []);
    const mn = v.map(x => x.tmin).concat(loc ? [loc.tmin] : []);
    const ps = v.map(x => x.p).filter(p => p != null);
    row.fc = {tmax: r1(median(mx)), tmin: r1(median(mn)), p: ps.length ? Math.round(median(ps)) : null,
      spread: mx.length > 1 ? r1(Math.max(...mx) - Math.min(...mx)) : 0, n: v.length + (loc ? 1 : 0),
      models: Object.fromEntries(Object.entries(per).map(([k, x]) => [k, {tmax: Math.round(x.tmax), tmin: Math.round(x.tmin)}]))};
    if (loc) row.fc.local = loc;
    used = true;
  });
  if (used) W.updated = at;
}

/* ---------- status line and footer ---------- */
const bar = document.getElementById('pwa-bar');
const foot = document.getElementById('pwa-foot');
let pending = false;
function status(kind, text, action) {
  bar.hidden = false;
  bar.className = 'pwa-bar is-' + kind;
  bar.innerHTML = '<span class="pwa-dot" aria-hidden="true"></span><span class="pwa-text"></span>';
  bar.querySelector('.pwa-text').textContent = text;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pwa-mini'; b.textContent = action.label;
    b.addEventListener('click', action.run);
    bar.appendChild(b);
  }
}
const checkAction = {label: 'Проверить обновления', run: () => refresh(true)};
const showAction = {label: 'Показать', run: () => reloadKeepingPlace()};
let dataStamp = null;  // updatedAt of the copy on screen
function offlineStatus() {
  const t = Number(LS.get(K_CHECKED)) || (dataStamp ? new Date(dataStamp).getTime() : 0);
  status('off', 'Офлайн-режим' + (t ? ' (копия от ' + ddmmhhmm(t) + ')' : ''), checkAction);
}

/* ---------- start the dashboard ---------- */
let started = false, touched = false;
const t0 = Date.now();
function shimViewer() {
  // the dashboard was written for the claude.ai viewer: here it runs as the parents' view-only page
  window.claude = {use: name => Promise.resolve(
    name === 'user' ? {canEdit: async () => false} :
    name === 'downloads' ? {save: async ({filename, data}) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
      a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }} : null)};
}
function startApp(plain) {
  const W = plain.state && plain.state.weather;
  tripDays = W && Array.isArray(W.days) ? W.days.map(d => ({city: d.city, date: d.date})) : [];
  dataStamp = plain.updatedAt;
  applyWeather(plain.state);
  document.getElementById('trip-data').textContent = JSON.stringify(plain.state);
  document.getElementById('trip-files').textContent = JSON.stringify(plain.files || {});
  shimViewer();
  const s = document.createElement('script');
  s.textContent = document.getElementById('app-js').textContent;
  document.body.appendChild(s);
  started = true;
  foot.hidden = false;
  let y = null;
  try { y = sessionStorage.getItem('pwa-scroll'); sessionStorage.removeItem('pwa-scroll'); } catch (e) {}
  if (y) requestAnimationFrame(() => window.scrollTo(0, Number(y)));
  setTimeout(() => ['pointerdown', 'keydown', 'wheel', 'touchmove'].forEach(e =>
    addEventListener(e, () => { touched = true; }, {once: true, passive: true, capture: true})), 300);
}
function reloadKeepingPlace() {
  try { sessionStorage.setItem('pwa-scroll', String(window.scrollY)); } catch (e) {}
  location.reload();
}
// fresh data in the first seconds, before the parent starts reading, is shown at once; later it waits for a tap
function freshArrived() {
  if (!started) return;
  if (!touched && Date.now() - t0 < 6000) { reloadKeepingPlace(); return; }
  pending = true;
  status('new', 'Пришли свежие данные', showAction);
}

/* ---------- background check ---------- */
let busy = false, lastCheck = 0;
async function refresh(manual) {
  if (busy) return;
  busy = true; lastCheck = Date.now();
  if (manual || !pending) status('wait', 'Проверяю обновления…');
  const wx = refreshWeather().catch(() => false);
  let dataNew = false, ok = false, pinChanged = false;
  try {
    const plain = await dbGet('plain');
    const pin = LS.get(K_PIN);
    const {p, url} = await fetchLatestEncryptedData();
    ok = true;
    LS.set(K_CHECKED, String(Date.now()));
    if (plain && pin && p.updatedAt > plain.updatedAt) {
      try {
        const state = await CryptoEngine.decryptPayload(p, password(pin));
        let files = plain.files, enc = await dbGet('enc') || {};
        if (p.filesHash !== plain.filesHash) {
          const ef = await fetchFiles(url, p.filesHash);
          files = await CryptoEngine.decryptPayload(ef, password(pin));
          enc = {...enc, files: ef};
        }
        await dbPut({plain: {state, files, updatedAt: p.updatedAt, filesHash: p.filesHash}, enc: {...enc, data: p}});
        dataNew = true;
      } catch (err) {
        if (isWrongPin(err)) pinChanged = true; else ok = false;
      }
    }
  } catch (e) { ok = false; }
  busy = false;
  // five weather models answer slower than the trip data: the status does not wait for them
  wx.then(n => { if (n && !pinChanged) freshArrived(); });
  if (pinChanged) { status('off', 'ПИН-код сменился — введите новый', {label: 'Ввести ПИН', run: () => forgetPin(true)}); return; }
  if (dataNew) { freshArrived(); if (!ok) return; }
  if (pending) return;
  if (ok) status('ok', 'Данные актуальны (обновлено: ' + hhmm(Date.now()) + ')');
  else offlineStatus();
}
document.addEventListener('visibilitychange', () => { if (started && document.visibilityState === 'visible' && Date.now() - lastCheck > 10 * 60000) refresh(); });
addEventListener('online', () => { if (started) refresh(); });

/* ---------- lock screen ---------- */
const lock = document.getElementById('pwa-lock');
const form = document.getElementById('pwa-lock-form');
const pinInput = document.getElementById('pwa-pin');
const err = document.getElementById('pwa-lock-err');
const linkRow = document.getElementById('pwa-link-row');
const linkInput = document.getElementById('pwa-link');
const openBtn = document.getElementById('pwa-open');
function showLock(message) {
  lock.hidden = false;
  linkRow.hidden = !!secret();
  err.textContent = message || '';
  document.documentElement.classList.add('pwa-locked');
  setTimeout(() => (linkRow.hidden ? pinInput : linkInput).focus(), 50);
}
form.addEventListener('submit', async e => {
  e.preventDefault();
  if (!secret() && !takeSecretFromLink(linkInput.value)) { err.textContent = 'Нужна ссылка из сообщения сына — откройте её или вставьте сюда целиком.'; return; }
  const pin = pinInput.value.replace(/\D/g, '');
  if (pin.length < 4) { err.textContent = 'В ПИН-коде 4 цифры или больше.'; pinInput.focus(); return; }
  openBtn.disabled = true; openBtn.textContent = 'Открываю…'; err.textContent = '';
  try {
    await unlock(pin);
    lock.hidden = true;
    document.documentElement.classList.remove('pwa-locked');
  } catch (ex) {
    err.textContent = isWrongPin(ex) ? 'ПИН-код не подходит. Проверьте цифры и попробуйте ещё раз.' : ex.message;
    pinInput.select();
  } finally { openBtn.disabled = false; openBtn.textContent = 'Открыть'; }
});

// newest of: the mirrors, the copy saved on this phone, the snapshot inside the APK
async function unlock(pin) {
  const pw = password(pin);
  const saved = await dbGet('enc') || {};
  let net = null;
  try { net = await fetchLatestEncryptedData(); LS.set(K_CHECKED, String(Date.now())); } catch (e) {}
  const cands = [net && {data: net.p, url: net.url}, saved.data && {data: saved.data, files: saved.files},
    FALLBACK_ENCRYPTED_DATA && FALLBACK_ENCRYPTED_DATA.data && {data: FALLBACK_ENCRYPTED_DATA.data, files: FALLBACK_ENCRYPTED_DATA.files}].filter(Boolean);
  if (!cands.length) throw new Error('Нет связи с интернетом. Подключитесь один раз, чтобы загрузить поездку на телефон.');
  cands.sort((a, b) => String(b.data.updatedAt).localeCompare(String(a.data.updatedAt)));
  const best = cands[0];
  const state = await CryptoEngine.decryptPayload(best.data, pw);
  // the hash names the content, not the key: after a PIN change the copy on the phone has the right hash but the old key
  const fileSrcs = [best.files, saved.files, FALLBACK_ENCRYPTED_DATA && FALLBACK_ENCRYPTED_DATA.files].filter(f => f && f.hash === best.data.filesHash);
  let ef = null, files = {};
  for (const f of fileSrcs) { try { files = await CryptoEngine.decryptPayload(f, pw); ef = f; break; } catch (e) {} }
  if (!ef && best.url) { try { const f = await fetchFiles(best.url, best.data.filesHash); files = await CryptoEngine.decryptPayload(f, pw); ef = f; } catch (e) {} }
  LS.set(K_PIN, pin);
  const plain = {state, files, updatedAt: best.data.updatedAt, filesHash: ef ? best.data.filesHash : null};
  await dbPut({plain, enc: {data: best.data, files: ef || undefined}});
  startApp(plain);
  if (net) status('ok', 'Данные актуальны (обновлено: ' + hhmm(Date.now()) + ')'); else offlineStatus();
  refreshWeather().then(n => { if (n) freshArrived(); }, () => {});
}

// the encrypted copy stays on the phone, so a new PIN opens it again even without internet
async function forgetPin(asked) {  // asked: the PIN already changed, no need to confirm
  if (!asked && !confirm('Приложение попросит ПИН-код ещё раз. Поездка останется в телефоне.')) return;
  LS.del(K_PIN);
  await dbPut({plain: undefined});
  location.reload();
}
document.getElementById('pwa-reset').addEventListener('click', () => forgetPin());
document.getElementById('pwa-build').textContent = 'Версия ' + CONFIG.BUILD;

/* ---------- boot ---------- */
if ('serviceWorker' in navigator && !window.Capacitor && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  // a new app version takes over in the background: show it like fresh data (not on the very first install)
  const hadWorker = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadWorker) freshArrived(); });
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
(async () => {
  const plain = LS.get(K_PIN) ? await dbGet('plain') : null;
  if (plain && plain.state) { startApp(plain); refresh(); }
  else showLock();
})();
})();
