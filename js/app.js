/* ============================================================
   Конструктор маршрута:
   даты + города прилёта/вылета + люди + выбор городов
   + ручная настройка дней + карта + отели → готовый план
   ============================================================ */

const cityById = Object.fromEntries(CITIES.map((c) => [c.id, c]));

const DEFAULT_SETTINGS = {
  arrive: '',
  depart: '',
  cityIn: 'shanghai',
  cityOut: 'shanghai',
  people: 2,
};

const state = {
  selected: new Set(['shanghai']),
  settings: { ...DEFAULT_SETTINGS },
  dayOverrides: {}, // cityId → число дней, выбранное пользователем
};

/* последние расчёты — нужны карте и степперам */
let lastAlloc = {};
let lastRoute = [];

/* ---------- Сохранение / загрузка ---------- */

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem('chinaTripState'));
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.selected)) {
        const valid = saved.selected.filter((id) => cityById[id]);
        if (valid.length) state.selected = new Set(valid);
      }
      if (saved.settings) {
        Object.assign(state.settings, saved.settings);
        if (!cityById[state.settings.cityIn]) state.settings.cityIn = 'shanghai';
        if (!cityById[state.settings.cityOut]) state.settings.cityOut = 'shanghai';
        state.settings.people = Math.min(10, Math.max(1, +state.settings.people || 2));
      }
      if (saved.dayOverrides && typeof saved.dayOverrides === 'object') {
        for (const [id, n] of Object.entries(saved.dayOverrides)) {
          if (cityById[id] && Number.isInteger(n)) state.dayOverrides[id] = n;
        }
      }
    }
  } catch (e) { /* повреждённые данные — по умолчанию */ }
}

function saveState() {
  try {
    localStorage.setItem('chinaTripState', JSON.stringify({
      selected: [...state.selected],
      settings: state.settings,
      dayOverrides: state.dayOverrides,
    }));
  } catch (e) { /* приватный режим */ }
}

/* ---------- Параметры поездки ---------- */

function tripDays() {
  const { arrive, depart } = state.settings;
  if (arrive && depart) {
    const diff = Math.round((new Date(depart) - new Date(arrive)) / 86400000) + 1;
    if (diff >= 2) return Math.min(diff, 30);
  }
  return 10; // по умолчанию — 10 дней
}

function datesValid() {
  const { arrive, depart } = state.settings;
  if (!arrive || !depart) return true;
  return new Date(depart) > new Date(arrive);
}

function isLockedCity(id) {
  return id === state.settings.cityIn || id === state.settings.cityOut;
}

function ensureCoreCities() {
  state.selected.add(state.settings.cityIn);
  state.selected.add(state.settings.cityOut);
}

/* Минимум дней города с учётом ручной настройки */
function effMin(id) {
  const c = cityById[id];
  const o = state.dayOverrides[id];
  return o ? Math.min(Math.max(o, c.min), c.max) : c.min;
}

function effMinSum(ids) {
  return ids.reduce((s, id) => s + effMin(id), 0);
}

/** Если дней стало меньше — убираем города с низким приоритетом */
function autoTrim() {
  const days = tripDays();
  const trimmed = [];
  while (effMinSum([...state.selected]) > days) {
    const removable = [...state.selected]
      .filter((id) => !isLockedCity(id))
      .sort((a, b) => cityById[a].priority - cityById[b].priority);
    if (!removable.length) {
      // остались только города прилёта/вылета — сбрасываем ручные дни
      if (Object.keys(state.dayOverrides).length) {
        state.dayOverrides = {};
        flashMessage('Дней стало меньше — ручная настройка дней сброшена к оптимуму');
        continue;
      }
      break;
    }
    const drop = removable[0];
    state.selected.delete(drop);
    delete state.dayOverrides[drop];
    trimmed.push(cityById[drop].name);
  }
  if (trimmed.length) {
    flashMessage(`Дней стало меньше — из маршрута убраны: ${trimmed.join(', ')}`);
  }
}

/* ---------- Распределение дней ---------- */

function allocateDays(ids) {
  const total = tripDays();
  const alloc = {};
  let remaining = total;

  ids.forEach((id) => {
    alloc[id] = effMin(id); // ручная настройка или минимум города
    remaining -= alloc[id];
  });

  // свободные дни раздаём только городам без ручной настройки
  const free = ids
    .filter((id) => !state.dayOverrides[id])
    .sort((a, b) => cityById[b].priority - cityById[a].priority);
  for (const stage of ['ideal', 'max']) {
    for (const id of free) {
      while (remaining > 0 && alloc[id] < cityById[id][stage]) {
        alloc[id]++;
        remaining--;
      }
      if (remaining === 0) break;
    }
    if (remaining === 0) break;
  }
  return { alloc, unused: Math.max(0, remaining) };
}

/* ---------- Оптимизация порядка городов ---------- */

function transferHours(t) {
  const s = String(t.time).replace(/,/g, '.');
  let hours = 0;
  const h = s.match(/(\d+(?:\.\d+)?)(?:\s*[–-]\s*(\d+(?:\.\d+)?))?\s*ч/);
  const m = s.match(/(\d+)(?:\s*[–-]\s*(\d+))?\s*мин/);
  if (h) hours += h[2] ? (parseFloat(h[1]) + parseFloat(h[2])) / 2 : parseFloat(h[1]);
  if (m) hours += (m[2] ? (parseInt(m[1], 10) + parseInt(m[2], 10)) / 2 : parseInt(m[1], 10)) / 60;
  return hours || 2;
}

const costCache = new Map();
function transferCost(a, b) {
  const key = [a, b].sort().join('|');
  if (costCache.has(key)) return costCache.get(key);
  const t = getTransfer(a, b);
  const price = parseInt(String(t.price).replace(/\D+/g, ''), 10) || 500;
  let hours = transferHours(t);
  if (t.mode === 'plane') hours += 3; // аэропорт, досмотр, ожидание
  const cost = price + hours * 120;   // час пути ≈ 120 ¥
  costCache.set(key, cost);
  return cost;
}

function pathCost(path, roundTrip) {
  let cost = 0;
  for (let i = 1; i < path.length; i++) cost += transferCost(path[i - 1], path[i]);
  if (roundTrip && path.length > 1) cost += transferCost(path[path.length - 1], path[0]);
  return cost;
}

/** Оптимальный порядок: полный перебор до 8 промежуточных городов,
    дальше — «ближайший сосед» + 2-opt улучшение */
function orderCities(ids) {
  const { cityIn, cityOut } = state.settings;
  const middle = ids.filter((id) => id !== cityIn && id !== cityOut);
  const roundTrip = cityIn === cityOut;

  if (middle.length > 8) return twoOptOrder(ids);

  let best = null;
  let bestCost = Infinity;

  const permute = (rest, path, cost) => {
    if (cost >= bestCost) return;
    if (!rest.length) {
      let total = cost;
      const last = path[path.length - 1];
      if (!roundTrip) total += transferCost(last, cityOut);
      else if (path.length > 1) total += transferCost(last, cityIn);
      if (total < bestCost) {
        bestCost = total;
        best = roundTrip ? [...path] : [...path, cityOut];
      }
      return;
    }
    const last = path[path.length - 1];
    for (let i = 0; i < rest.length; i++) {
      permute(
        [...rest.slice(0, i), ...rest.slice(i + 1)],
        [...path, rest[i]],
        cost + transferCost(last, rest[i])
      );
    }
  };

  permute(middle, [cityIn], 0);
  return best || (roundTrip ? [cityIn] : [cityIn, cityOut]);
}

/** Запасной вариант: «ближайший сосед» + 2-opt */
function twoOptOrder(ids) {
  const { cityIn, cityOut } = state.settings;
  const roundTrip = cityIn === cityOut;
  const middle = new Set(ids.filter((id) => id !== cityIn && id !== cityOut));

  const route = [cityIn];
  let cur = cityById[cityIn];
  while (middle.size) {
    let best = null;
    let bestD = Infinity;
    for (const id of middle) {
      const c = cityById[id];
      const d = Math.hypot(c.lat - cur.lat, c.lng - cur.lng);
      if (d < bestD) { bestD = d; best = id; }
    }
    route.push(best);
    middle.delete(best);
    cur = cityById[best];
  }
  if (!roundTrip) route.push(cityOut);

  // 2-opt: переворачиваем отрезки, пока это удешевляет путь (концы закреплены)
  const lastFixed = roundTrip ? 0 : 1;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 60) {
    improved = false;
    for (let i = 1; i < route.length - 1 - lastFixed; i++) {
      for (let j = i + 1; j < route.length - lastFixed; j++) {
        const candidate = [
          ...route.slice(0, i),
          ...route.slice(i, j + 1).reverse(),
          ...route.slice(j + 1),
        ];
        if (pathCost(candidate, roundTrip) < pathCost(route, roundTrip)) {
          route.splice(0, route.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  return route;
}

/* ---------- Бюджет ---------- */

function transportBudget(route) {
  let sum = 0;
  for (let i = 1; i < route.length; i++) {
    const t = getTransfer(route[i - 1], route[i]);
    const n = parseInt(String(t.price).replace(/\D+/g, ''), 10);
    if (!isNaN(n)) sum += n;
  }
  const { cityIn, cityOut } = state.settings;
  if (cityIn === cityOut && route.length > 1) {
    const t = getTransfer(route[route.length - 1], cityIn);
    const n = parseInt(String(t.price).replace(/\D+/g, ''), 10);
    if (!isNaN(n)) sum += n;
  }
  return sum * state.settings.people;
}

function roomsCount() {
  return Math.ceil(state.settings.people / 2);
}

function hotelBudget(route, alloc) {
  const rooms = roomsCount();
  let sum = 0;
  route.forEach((id) => {
    const h = (HOTELS[id] || [])[0];
    if (h && h.price) sum += h.price * alloc[id] * rooms;
  });
  return sum;
}

/* ---------- Форматирование ---------- */

const fmtDay = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const fmtWeekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });

function dayDate(n) {
  const { arrive, depart } = state.settings;
  if (!arrive || !depart || !datesValid()) return '';
  const d = new Date(arrive);
  d.setDate(d.getDate() + n - 1);
  return `${fmtDay.format(d)}, ${fmtWeekday.format(d)}`;
}

function dayWord(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'день';
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'дня';
  return 'дней';
}

function nightWord(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'ночь';
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'ночи';
  return 'ночей';
}

function roomWord(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'номер';
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'номера';
  return 'номеров';
}

function peopleWord(n) {
  if (n === 1) return 'путешественник';
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'путешественника';
  return 'путешественников';
}

function fmtYuan(n) {
  return n.toLocaleString('ru-RU');
}

/* ---------- Рендер: параметры поездки ---------- */

function renderSettings() {
  const s = state.settings;
  document.getElementById('arriveDate').value = s.arrive;
  document.getElementById('departDate').value = s.depart;
  document.getElementById('cityIn').value = s.cityIn;
  document.getElementById('cityOut').value = s.cityOut;
  document.getElementById('peopleCount').textContent = s.people;

  const summary = document.getElementById('tripSummary');
  const days = tripDays();
  const parts = [];
  if (s.arrive && s.depart && datesValid()) {
    parts.push(`${fmtDay.format(new Date(s.arrive))} — ${fmtDay.format(new Date(s.depart))}`);
  }
  parts.push(`${days} ${dayWord(days)}`);
  parts.push(`${s.people} ${peopleWord(s.people)}`);
  summary.textContent = parts.join(' · ');

  const err = document.getElementById('dateError');
  err.textContent = datesValid() ? '' : 'Дата отъезда должна быть позже даты приезда — считаем 10 дней.';
}

/* ---------- Рендер: карточки городов ---------- */

function renderCityPicker() {
  const grid = document.getElementById('cityGrid');
  grid.innerHTML = CITIES.map((c) => {
    const sel = state.selected.has(c.id);
    const locked = isLockedCity(c.id);
    const badge = c.id === state.settings.cityIn
      ? '<span class="badge-start">прилёт</span>'
      : (c.id === state.settings.cityOut ? '<span class="badge-start">вылет</span>' : '');
    return `
      <button class="city-card ${sel ? 'selected' : ''} ${locked ? 'locked' : ''}"
              data-id="${c.id}" type="button" aria-pressed="${sel}">
        <div class="city-card-img">
          <span class="city-emoji" aria-hidden="true">${c.emoji}</span>
          <img src="${c.image}" alt="${c.name}" loading="lazy" onerror="this.style.display='none'">
        </div>
        <div class="city-card-body">
          <div class="city-card-title">
            <span class="city-name">${c.name}</span>
            <span class="city-cn">${c.cn}</span>
          </div>
          <p class="city-tagline">${c.tagline}</p>
          <div class="city-days">${c.min === c.max ? c.min : c.min + '–' + c.max} ${dayWord(c.max)} ${badge}</div>
        </div>
        <span class="city-check" aria-hidden="true">${sel ? '✓' : '+'}</span>
      </button>`;
  }).join('');

  grid.querySelectorAll('.city-card').forEach((card) => {
    card.addEventListener('click', () => toggleCity(card.dataset.id));
  });
}

function toggleCity(id) {
  const city = cityById[id];
  if (isLockedCity(id)) {
    flashMessage(`${city.name} — город ${id === state.settings.cityIn ? 'прилёта' : 'вылета'}, он всегда в маршруте`);
    return;
  }
  if (state.selected.has(id)) {
    state.selected.delete(id);
    delete state.dayOverrides[id];
  } else {
    const needed = effMinSum([...state.selected]) + city.min;
    if (needed > tripDays()) {
      flashMessage(`Не хватает дней: на «${city.name}» нужно минимум ${city.min} ${dayWord(city.min)}. Уберите другой город или сдвиньте даты.`);
      return;
    }
    state.selected.add(id);
  }
  update();
}

let msgTimer = null;
function flashMessage(text) {
  const el = document.getElementById('pickerMessage');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

/* ---------- Карта Китая ---------- */

/* Подложка — images/map.png (3840×3232). Проекция карты коническая,
   поэтому широта/долгота переводятся в пиксели квадратичной моделью,
   откалиброванной по опорным точкам побережья. viewBox = 960×808 (пиксели ÷ 4). */
const MAP_CFG = { w: 960, h: 808 };
const PROJ_X = [-8021.104745, 128.732092, 24.907076, 0.147278, -0.339008, -0.647235];
const PROJ_Y = [2216.243261, 34.777449, -33.416641, -0.04767, -0.169052, -0.62961];

function mapXY(lat, lng) {
  const f = [1, lng, lat, lng * lat, lng * lng, lat * lat];
  const px = PROJ_X.reduce((s, c, i) => s + c * f[i], 0) / 4;
  const py = PROJ_Y.reduce((s, c, i) => s + c * f[i], 0) / 4;
  return [Math.round(px * 10) / 10, Math.round(py * 10) / 10];
}

/* Промежуточные точки реальных ж/д-коридоров, [широта, долгота].
   Ключ — 'id1|id2' в алфавитном порядке, точки идут от id1 к id2 */
const RAIL_WAYPOINTS = {
  'beijing|shanghai':   [[36.65, 117.0], [34.26, 117.19], [32.06, 118.80], [31.30, 120.58]], // Цзинань, Сюйчжоу, Нанкин, Сучжоу
  'beijing|nanjing':    [[36.65, 117.0], [34.26, 117.19]],
  'beijing|suzhou':     [[36.65, 117.0], [34.26, 117.19], [32.06, 118.80]],
  'beijing|hangzhou':   [[36.65, 117.0], [34.26, 117.19], [32.06, 118.80]],
  'beijing|huangshan':  [[36.65, 117.0], [32.06, 118.80]],
  'beijing|xian':       [[38.04, 114.51], [34.75, 113.62]], // Шицзячжуан, Чжэнчжоу
  'beijing|chengdu':    [[38.04, 114.51], [34.75, 113.62], [34.34, 108.94]], // через Сиань
  'shanghai|xian':      [[32.06, 118.80], [34.26, 117.19], [34.75, 113.62]],
  'suzhou|xian':        [[32.06, 118.80], [34.75, 113.62]],
  'hangzhou|xian':      [[31.86, 117.28], [34.75, 113.62]], // Хэфэй, Чжэнчжоу
  'nanjing|xian':       [[34.26, 117.19], [34.75, 113.62]],
  'chengdu|xian':       [[33.1, 107.0]], // через горы Циньлин
  'chongqing|xian':     [[31.8, 108.3]],
  'chengdu|guilin':     [[26.65, 106.63]], // Гуйян
  'chongqing|guilin':   [[26.65, 106.63]],
  'chongqing|guangzhou': [[26.65, 106.63], [24.8, 112.0]],
  'guangzhou|guilin':   [[24.5, 111.3]],
  'guilin|shenzhen':    [[23.6, 113.1]], // через Гуанчжоу
  'chongqing|zhangjiajie': [[29.3, 108.8]],
  'guilin|zhangjiajie': [[26.9, 109.7]], // Хуайхуа
  'hangzhou|huangshan': [[29.9, 119.0]],
  'huangshan|nanjing':  [[31.3, 118.4]],
  'huangshan|shanghai': [[30.27, 120.16]], // через Ханчжоу
  'huangshan|suzhou':   [[30.27, 120.16]],
  'nanjing|shanghai':   [[31.30, 120.58]],
  'nanjing|zhujiajiao': [[31.30, 120.58], [31.23, 121.47]],
  'beijing|zhujiajiao': [[36.65, 117.0], [32.06, 118.80], [31.23, 121.47]],
  'xian|zhujiajiao':    [[34.75, 113.62], [32.06, 118.80], [31.23, 121.47]],
  'huangshan|zhujiajiao': [[30.27, 120.16], [31.23, 121.47]],
};

function railPoints(a, b) {
  const key = [a, b].sort().join('|');
  const wps = RAIL_WAYPOINTS[key];
  if (!wps) return [];
  return key.startsWith(a + '|') ? wps : [...wps].reverse();
}

/* Смещения подписей, чтобы плотные города не слипались: [dx, dy, anchor] */
const LABEL_POS = {
  shanghai: [14, 6],
  suzhou: [-13, -8, 'end'],
  zhujiajiao: [10, 22],
  hangzhou: [-13, 15, 'end'],
  nanjing: [13, -6],
  huangshan: [-13, 8, 'end'],
  beijing: [14, 3],
  xian: [13, -6],
  chengdu: [-13, -8, 'end'],
  chongqing: [14, 15],
  guilin: [13, -6],
  zhangjiajie: [-13, -10, 'end'],
  guangzhou: [-15, 5, 'end'],
  shenzhen: [14, 13],
};

/** Плавный путь через точки: скругляем углы квадратичными кривыми */
function smoothPath(pts) {
  if (pts.length === 2) {
    const [A, B] = pts;
    const bow = 0.05;
    const cx = (A[0] + B[0]) / 2 - (B[1] - A[1]) * bow;
    const cy = (A[1] + B[1]) / 2 + (B[0] - A[0]) * bow;
    return `M ${A[0]} ${A[1]} Q ${cx} ${cy} ${B[0]} ${B[1]}`;
  }
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q ${pts[i][0]} ${pts[i][1]} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L ${last[0]} ${last[1]}`;
}

/* «Линза»: под курсором сквозь карту проступает рисованная карта
   с миниатюрами достопримечательностей. Файл появится позже —
   ищем images/map-art.jpg или .png и включаем эффект, если он есть */
let lensArtSrc = null;

/* Аффинная подгонка рисованной карты (1536×1024) под силуэт подложки —
   совмещение масок суши по центроиду и главным осям */
const ART_MATRIX = 'matrix(0.67916 -0.04686 0.03215 0.69530 -56.28 77.39)';

function probeLensArt() {
  const candidates = ['images/map-art.jpg', 'images/map-art.png'];
  const tryNext = (i) => {
    if (i >= candidates.length) return;
    const probe = new Image();
    probe.onload = () => { lensArtSrc = candidates[i]; renderMap(); };
    probe.onerror = () => tryNext(i + 1);
    probe.src = candidates[i];
  };
  tryNext(0);
}

function renderMap() {
  const wrap = document.getElementById('chinaMap');
  if (!wrap) return;

  const route = lastRoute;
  const roundTrip = state.settings.cityIn === state.settings.cityOut && route.length > 1;

  let lines = '';
  const drawLeg = (a, b) => {
    const A = mapXY(cityById[a].lat, cityById[a].lng);
    const B = mapXY(cityById[b].lat, cityById[b].lng);
    const mode = getTransfer(a, b).mode;
    if (mode === 'plane') {
      // авиамаршрут — дуга со стрелкой и самолётиком на середине
      const mx = (A[0] + B[0]) / 2;
      const my = (A[1] + B[1]) / 2;
      const bow = 0.16;
      const cx = mx - (B[1] - A[1]) * bow;
      const cy = my + (B[0] - A[0]) * bow;
      lines += `<path class="air-route" marker-end="url(#arrowHead)"
        d="M ${A[0]} ${A[1]} Q ${cx} ${cy} ${B[0]} ${B[1]}"/>`;
      const px = 0.25 * A[0] + 0.5 * cx + 0.25 * B[0];
      const py = 0.25 * A[1] + 0.5 * cy + 0.25 * B[1];
      const ang = Math.atan2(B[1] - A[1], B[0] - A[0]) * 180 / Math.PI + 90;
      lines += `<g class="plane-glyph" transform="translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${ang.toFixed(1)})">
        <path d="M0 -8 L1.8 -2 7.5 0.6 7.5 2.4 1.8 1 1.4 5.4 3.4 7.2 3.4 8.6 0 7.6 -3.4 8.6 -3.4 7.2 -1.4 5.4 -1.8 1 -7.5 2.4 -7.5 0.6 -1.8 -2 Z"/>
      </g>`;
    } else {
      // ж/д — двойная линия «со шпалами» по реальному коридору
      const pts = [A, ...railPoints(a, b).map(([lat, lng]) => mapXY(lat, lng)), B];
      const d = smoothPath(pts);
      lines += `<path class="rail-base" marker-end="url(#arrowHead)" d="${d}"/>`;
      lines += `<path class="rail-ties" d="${d}"/>`;
    }
  };
  for (let i = 1; i < route.length; i++) drawLeg(route[i - 1], route[i]);
  if (roundTrip) drawLeg(route[route.length - 1], route[0]);

  let dots = '';
  CITIES.forEach((c) => {
    const [x, y] = mapXY(c.lat, c.lng);
    const sel = state.selected.has(c.id);
    if (sel) {
      // «жемчужина»: белое ядро с золотой сердцевиной и расходящейся волной
      dots += `
        <g class="city-marker">
          <circle class="ping" cx="${x}" cy="${y}" r="9"/>
          <circle class="marker-core" cx="${x}" cy="${y}" r="6.3"/>
          <circle class="marker-inner" cx="${x}" cy="${y}" r="3.6"/>
        </g>
        <circle class="map-dot sel" data-id="${c.id}" cx="${x}" cy="${y}" r="12"
          tabindex="0" aria-label="${c.name}, в маршруте"/>`;
      const [dx, dy, anchor] = LABEL_POS[c.id] || [13, 5];
      dots += `<text class="map-label" x="${x + dx}" y="${y + dy}"
        text-anchor="${anchor || 'start'}">${c.name}</text>`;
    } else {
      dots += `<circle class="map-dot idle" data-id="${c.id}" cx="${x}" cy="${y}" r="5"
        tabindex="0" aria-label="${c.name}"/>`;
    }
  });

  const lensDefs = lensArtSrc ? `
        <radialGradient id="brushGrad">
          <stop offset="0%" stop-color="#fff"/>
          <stop offset="60%" stop-color="#fff" stop-opacity="0.85"/>
          <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
        </radialGradient>
        <mask id="lensMask" maskUnits="userSpaceOnUse" x="0" y="0"
              width="${MAP_CFG.w}" height="${MAP_CFG.h}">
          <g id="brushTrail"></g>
        </mask>` : '';
  const lensArt = lensArtSrc ? `
      <g mask="url(#lensMask)" class="lens-art">
        <image href="${lensArtSrc}" width="1536" height="1024" preserveAspectRatio="none"
               transform="${ART_MATRIX}"/>
      </g>` : '';

  wrap.innerHTML = `
    <svg viewBox="0 0 ${MAP_CFG.w} ${MAP_CFG.h}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="arrowHead" viewBox="0 0 10 10" refX="7.5" refY="5"
                markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="#fff" stroke="rgba(0,0,0,0.3)" stroke-width="0.8"/>
        </marker>
        ${lensDefs}
      </defs>
      <image href="images/map.png" x="0" y="0" width="${MAP_CFG.w}" height="${MAP_CFG.h}"
             opacity="0.9" preserveAspectRatio="xMidYMid meet"/>
      ${lines}
      ${lensArt}
      ${dots}
    </svg>`;

  const lensNote = document.getElementById('mapNoteLens');
  if (lensNote) lensNote.hidden = !lensArtSrc;

  bindMapEvents(wrap);
}

function bindMapEvents(wrap) {
  const tooltip = document.getElementById('mapTooltip');
  const container = wrap.closest('.map-wrap');

  const show = (dot) => {
    const id = dot.dataset.id;
    const c = cityById[id];
    const sel = state.selected.has(id);
    const days = lastAlloc[id];
    const top = c.dayPlans[0].spots.slice(0, 3).map((s) => s.name).join(' · ');
    tooltip.innerHTML = sel
      ? `<strong>${c.name} <span class="cn">${c.cn}</span></strong>
         <span class="tt-days">${days} ${dayWord(days)} в маршруте</span>
         <p>${c.tagline}</p>
         <p class="tt-top">Главное: ${top}</p>`
      : `<strong>${c.name} <span class="cn">${c.cn}</span></strong>
         <p>${c.tagline}</p>
         <p class="tt-top">Нажмите на точку, чтобы добавить в маршрут</p>`;
    const dotRect = dot.getBoundingClientRect();
    const contRect = container.getBoundingClientRect();
    tooltip.hidden = false;
    const left = Math.min(
      Math.max(dotRect.left - contRect.left + dotRect.width / 2, 110),
      contRect.width - 110
    );
    tooltip.style.left = left + 'px';
    tooltip.style.top = (dotRect.top - contRect.top - 12) + 'px';
  };

  wrap.querySelectorAll('.map-dot').forEach((dot) => {
    dot.addEventListener('mouseenter', () => show(dot));
    dot.addEventListener('focus', () => show(dot));
    dot.addEventListener('mouseleave', () => { tooltip.hidden = true; });
    dot.addEventListener('blur', () => { tooltip.hidden = true; });
    dot.addEventListener('click', () => {
      tooltip.hidden = true;
      toggleCity(dot.dataset.id);
    });
  });

  // «кисть»: курсор стирает флаг, открывая рисованную карту,
  // след постепенно затягивается обратно
  const svg = wrap.querySelector('svg');
  const trail = svg.querySelector('#brushTrail');
  if (trail) {
    const NS = 'http://www.w3.org/2000/svg';
    let lastX = -100;
    let lastY = -100;
    svg.addEventListener('mousemove', (e) => {
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
      if (Math.hypot(p.x - lastX, p.y - lastY) < 13) return; // мазки, а не заливка
      lastX = p.x;
      lastY = p.y;
      const blob = document.createElementNS(NS, 'circle');
      blob.setAttribute('cx', p.x.toFixed(1));
      blob.setAttribute('cy', p.y.toFixed(1));
      blob.setAttribute('r', 58);
      blob.setAttribute('fill', 'url(#brushGrad)');
      trail.appendChild(blob);
      // CSS-переходы внутри <mask> не анимируются — затухание ведём вручную
      const born = performance.now();
      const HOLD = 0.5;  // мазок держится, сек
      const FADE = 0.9;  // и затем растворяется, сек
      const tick = (now) => {
        if (!blob.isConnected) return;
        const t = (now - born) / 1000;
        if (t >= HOLD + FADE) { blob.remove(); return; }
        if (t > HOLD) {
          blob.setAttribute('opacity', (1 - (t - HOLD) / FADE).toFixed(3));
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      // страховка: rAF замирает в скрытой вкладке — не копим след
      setTimeout(() => blob.remove(), (HOLD + FADE) * 1000 + 700);
    });
  }
}

/* ---------- Рендер: маршрут ---------- */

function renderItinerary() {
  const ids = [...state.selected];
  const { alloc, unused } = allocateDays(ids);
  const route = orderCities(ids);
  lastAlloc = alloc;
  lastRoute = route;

  const total = tripDays();
  const s = state.settings;
  const used = total - unused;

  document.getElementById('daysUsed').textContent = used;
  document.getElementById('daysTotal').textContent = total;
  document.getElementById('daysBar').style.width = (used / total) * 100 + '%';
  document.getElementById('routeLine').textContent =
    route.map((id) => cityById[id].name).join(' → ');

  const hint = document.getElementById('daysHint');
  hint.textContent = unused > 0
    ? `Осталось ${unused} свободных ${dayWord(unused)} — добавьте город, дни городам (кнопка «+») или отдых.`
    : 'Все дни распределены.';

  const resetBtn = document.getElementById('resetDays');
  resetBtn.hidden = Object.keys(state.dayOverrides).length === 0;

  const tBudget = transportBudget(route);
  const hBudget = hotelBudget(route, alloc);
  const grand = tBudget + hBudget;
  document.getElementById('budgetLine').innerHTML = grand
    ? `Переезды ≈ ${fmtYuan(tBudget)} ¥ · отели ≈ ${fmtYuan(hBudget)} ¥ ·
       итого ≈ <strong>${fmtYuan(grand)} ¥</strong> на ${s.people} ${peopleWord(s.people)} (~${fmtYuan(Math.round(grand * 12))} ₽)`
    : '';

  const wrap = document.getElementById('itinerary');
  let html = '';
  let dayNum = 0;
  const rooms = roomsCount();

  route.forEach((id, i) => {
    const city = cityById[id];
    const days = alloc[id];

    if (i > 0) {
      const t = getTransfer(route[i - 1], id);
      html += `
        <div class="transfer">
          <span class="transfer-icon">${MODE_ICONS[t.mode]}</span>
          <div>
            <strong>${cityById[route[i - 1]].name} → ${city.name}:</strong>
            ${MODE_NAMES[t.mode]}, ${t.time}, от ${t.price.replace('от ', '')}
            ${t.note ? `<span class="transfer-note">${t.note}</span>` : ''}
          </div>
        </div>`;
    }

    const overridden = !!state.dayOverrides[id];
    html += `
      <div class="city-block">
        <div class="city-block-header">
          <img src="${city.image}" alt="${city.name}" loading="lazy" onerror="this.style.display='none'">
          <div class="city-block-overlay"></div>
          <div class="city-block-title">
            <div>
              <h3>${city.name} <span class="cn">${city.cn}</span></h3>
              <p>${city.tagline}</p>
            </div>
            <div class="day-stepper ${overridden ? 'overridden' : ''}" title="Сколько дней провести в городе">
              <button type="button" class="stepper-btn" data-id="${id}" data-action="minus"
                aria-label="Меньше дней в городе ${city.name}" ${days <= city.min ? 'disabled' : ''}>−</button>
              <span class="stepper-value">${days} ${dayWord(days)}</span>
              <button type="button" class="stepper-btn" data-id="${id}" data-action="plus"
                aria-label="Больше дней в городе ${city.name}" ${days >= city.max ? 'disabled' : ''}>+</button>
            </div>
          </div>
        </div>`;

    const hotels = HOTELS[id];
    if (hotels && hotels[0] && hotels[0].price) {
      const h = hotels[0];
      const alt = hotels[1];
      const totalHotel = h.price * days * rooms;
      html += `
        <div class="hotel-tip">
          <span class="hotel-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 18h18M3 18v2M21 18v2M6 10V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3"/><path d="M7 10h4v0"/></svg></span>
          <div>
            <strong>Где жить: ${h.area}.</strong> ${h.why[0].toUpperCase() + h.why.slice(1)}.
            <span class="hotel-price">≈ ${fmtYuan(totalHotel)} ¥ за ${days} ${nightWord(days)}
            (${rooms} ${roomWord(rooms)} × ${h.price} ¥)</span>
            ${alt && alt.price ? `<span class="hotel-alt">Бюджетно: ${alt.area} — от ${alt.price} ¥/ночь (${alt.why}).</span>` : ''}
          </div>
        </div>`;
    }

    for (let d = 0; d < days; d++) {
      dayNum++;
      const plan = city.dayPlans[d] || FREE_DAY;
      const date = dayDate(dayNum);
      html += `
        <details class="day" ${dayNum <= 3 ? 'open' : ''}>
          <summary>
            <span class="day-num">День ${dayNum}</span>
            <span class="day-title">${plan.title}${date ? ` <span class="day-date">· ${date}</span>` : ''}</span>
            <span class="day-arrow" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </span>
          </summary>
          <ul class="spots">
            ${plan.spots.map((sp) => `
              <li class="spot">
                <span class="spot-time">${sp.time}</span>
                <div class="spot-body">
                  <div class="spot-name">${sp.name} <span class="cn">${sp.cn}</span></div>
                  <p class="spot-desc">${sp.desc}</p>
                  <span class="spot-price">${sp.price}</span>
                </div>
              </li>`).join('')}
          </ul>
        </details>`;
    }
    html += '</div>';
  });

  if (unused > 0) {
    html += `
      <div class="transfer free-days">
        <span class="transfer-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></span>
        <div><strong>${unused === 1 ? 'Остался 1 свободный день' : `Осталось ${unused} свободных ${dayWord(unused)}`}.</strong>
        Добавьте дни городам кнопкой «+», добавьте ещё город — или оставьте запас на отдых.</div>
      </div>`;
  }

  const last = route[route.length - 1];
  let homeText;
  if (s.cityIn === s.cityOut && route.length > 1) {
    const back = getTransfer(last, s.cityOut);
    homeText = `<strong>Возвращение:</strong> ${cityById[last].name} → ${cityById[s.cityOut].name}
      (${MODE_NAMES[back.mode]}, ${back.time}, от ${back.price.replace('от ', '')}) — и вылет домой из ${cityById[s.cityOut].gen}.`;
  } else {
    homeText = `<strong>Вылет домой</strong> — из ${cityById[s.cityOut].gen}${s.arrive && s.depart && datesValid() ? ', ' + fmtDay.format(new Date(s.depart)) : ''}.
      Проверяйте рейсы заранее: удобные хабы — Шанхай, Пекин и Гуанчжоу.`;
  }
  html += `
    <div class="transfer home">
      <span class="transfer-icon">${MODE_ICONS.plane}</span>
      <div>${homeText}</div>
    </div>`;

  wrap.innerHTML = html;
}

/* ---------- Настройка дней (степперы) ---------- */

function stepDay(id, action) {
  const city = cityById[id];
  const cur = lastAlloc[id];
  if (action === 'plus') {
    if (cur >= city.max) {
      flashMessage(`${city.name}: максимум ${city.max} ${dayWord(city.max)} — на дольше не хватит программы`);
      return;
    }
    const candidate = { ...state.dayOverrides, [id]: cur + 1 };
    const sum = [...state.selected].reduce((s, cid) => {
      const c = cityById[cid];
      const o = candidate[cid];
      return s + (o ? Math.min(Math.max(o, c.min), c.max) : c.min);
    }, 0);
    if (sum > tripDays()) {
      flashMessage('Свободных дней нет — уберите день у другого города или сдвиньте даты');
      return;
    }
    state.dayOverrides[id] = cur + 1;
  } else {
    if (cur <= city.min) {
      flashMessage(`${city.name}: минимум ${city.min} ${dayWord(city.min)} — иначе город лучше убрать совсем`);
      return;
    }
    state.dayOverrides[id] = cur - 1;
  }
  update();
}

/* ---------- Появление секций при скролле (в духе Apple) ---------- */

let revealObserver = null;
let dynamicRevealed = false;

function setupReveals() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.body.classList.add('anim');

  revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        en.target.classList.add('in-view');
        revealObserver.unobserve(en.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

  document.querySelectorAll(
    '.section-kicker, .section h2, .section-sub, .trip-form, .picker-status, ' +
    '.map-wrap, .route-line-wrap, .disclaimer, .info-tabs, .phrase-table-wrap, .phrase-tip'
  ).forEach((el) => markReveal(el));

  // параллакс фото и «скраб» контента шапки: при прокрутке текст
  // плавно уплывает и растворяется, как на страницах Apple
  const heroImg = document.querySelector('.hero-img');
  const heroContent = document.querySelector('.hero-content');
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    const vh = window.innerHeight;
    if (y < vh * 1.2) {
      if (heroImg) heroImg.style.transform = `translateY(${y * 0.28}px) scale(1.06)`;
      if (heroContent) {
        heroContent.style.opacity = Math.max(0, 1 - y / (vh * 0.75));
        heroContent.style.transform = `translateY(${y * 0.14}px)`;
      }
    }
  }, { passive: true });
}

function markReveal(el, delayMs) {
  if (!revealObserver || el.classList.contains('reveal')) return;
  el.classList.add('reveal');
  if (delayMs) el.style.setProperty('--reveal-delay', delayMs + 'ms');
  revealObserver.observe(el);
}

/* Карточки городов и блоки маршрута анимируем только при первой
   отрисовке — чтобы список не мигал при каждом клике */
function revealDynamic() {
  if (!revealObserver || dynamicRevealed) return;
  dynamicRevealed = true;
  document.querySelectorAll('.city-grid .city-card').forEach((el, i) => markReveal(el, (i % 3) * 80));
  document.querySelectorAll('#itinerary .city-block, #itinerary .transfer').forEach((el) => markReveal(el));
}

/* ---------- Общий рендер ---------- */

function update() {
  ensureCoreCities();
  autoTrim();
  saveState();
  renderSettings();
  renderCityPicker();
  renderItinerary();
  renderMap();
  revealDynamic();
}

/* ---------- Обработчики параметров ---------- */

function setupSettings() {
  const opts = CITIES.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  document.getElementById('cityIn').innerHTML = opts;
  document.getElementById('cityOut').innerHTML = opts;

  document.getElementById('arriveDate').addEventListener('change', (e) => {
    state.settings.arrive = e.target.value;
    update();
  });
  document.getElementById('departDate').addEventListener('change', (e) => {
    state.settings.depart = e.target.value;
    update();
  });
  document.getElementById('cityIn').addEventListener('change', (e) => {
    state.settings.cityIn = e.target.value;
    update();
  });
  document.getElementById('cityOut').addEventListener('change', (e) => {
    state.settings.cityOut = e.target.value;
    update();
  });
  document.getElementById('peopleMinus').addEventListener('click', () => {
    state.settings.people = Math.max(1, state.settings.people - 1);
    update();
  });
  document.getElementById('peoplePlus').addEventListener('click', () => {
    state.settings.people = Math.min(10, state.settings.people + 1);
    update();
  });
  document.getElementById('resetDays').addEventListener('click', () => {
    state.dayOverrides = {};
    flashMessage('Дни пересчитаны к оптимальному распределению');
    update();
  });

  // степперы дней в маршруте (делегирование — список перерисовывается)
  document.getElementById('itinerary').addEventListener('click', (e) => {
    const btn = e.target.closest('.stepper-btn');
    if (btn && !btn.disabled) stepDay(btn.dataset.id, btn.dataset.action);
  });
}

/* ---------- Фоновая музыка ---------- */

const ICON_SOUND_ON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6.5 8.5H3v7h3.5L11 19z" fill="currentColor" stroke="none"/><path d="M15 9a4 4 0 0 1 0 6M17.8 6.5a8 8 0 0 1 0 11"/></svg>`;
const ICON_SOUND_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6.5 8.5H3v7h3.5L11 19z" fill="currentColor" stroke="none"/><path d="m15.5 9.5 5 5M20.5 9.5l-5 5"/></svg>`;

function setupMusic() {
  const audio = document.getElementById('bgMusic');
  const btn = document.getElementById('musicBtn');
  if (!audio || !btn) return;

  audio.volume = 0.18; // тихий фон
  let muted = false;
  try { muted = localStorage.getItem('chinaMusicMuted') === '1'; } catch (e) { /* приватный режим */ }
  audio.muted = muted;

  const refresh = () => {
    btn.innerHTML = audio.muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    btn.classList.toggle('muted', audio.muted);
    btn.setAttribute('aria-pressed', String(audio.muted));
    btn.setAttribute('aria-label', audio.muted ? 'Включить музыку' : 'Выключить музыку');
  };
  refresh();

  const tryPlay = () => { audio.play().catch(() => { /* автозапуск заблокирован — ждём клика */ }); };
  tryPlay();

  // браузеры блокируют автозвук до первого действия пользователя
  const unlock = () => {
    tryPlay();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  btn.addEventListener('click', () => {
    audio.muted = !audio.muted;
    if (!audio.muted) tryPlay();
    try { localStorage.setItem('chinaMusicMuted', audio.muted ? '1' : '0'); } catch (e) { /* ок */ }
    refresh();
  });
}

/* ---------- Навигация и табы ---------- */

function setupNav() {
  const burger = document.getElementById('burger');
  const menu = document.getElementById('navMenu');
  burger.addEventListener('click', () => {
    menu.classList.toggle('open');
    burger.classList.toggle('active');
  });
  menu.querySelectorAll('a').forEach((a) =>
    a.addEventListener('click', () => {
      menu.classList.remove('open');
      burger.classList.remove('active');
    })
  );
  const nav = document.querySelector('.nav');
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 40);
  }, { passive: true });
}

function setupTabs() {
  const tabs = document.querySelectorAll('.info-tab');
  const panels = document.querySelectorAll('.info-panel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      panels.forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.panel).classList.add('active');
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  setupSettings();
  setupMusic();
  setupNav();
  setupTabs();
  setupReveals();
  probeLensArt();
  update();
});
