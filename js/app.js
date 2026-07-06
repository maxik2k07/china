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

/* Упрощённый контур материкового Китая, [долгота, широта] */
const CHINA_OUTLINE = [
  [73.6, 39.4], [75, 37.2], [78, 35.6], [79, 33], [81.5, 30.4], [85, 28.5],
  [88.1, 27.9], [92, 27.5], [94.6, 29.3], [96, 29], [97.5, 28.2], [98.7, 25.9],
  [97.6, 24.3], [98.9, 23.2], [100.2, 21.5], [101.7, 21.1], [102.5, 22.4],
  [105, 23], [106.7, 22.1], [108.1, 21.5], [109.6, 21.4], [110.4, 20.3],
  [111.8, 21.6], [113.2, 22.1], [114.8, 22.6], [116.6, 23.3], [118.1, 24.5],
  [119.6, 25.7], [120.2, 27.3], [121.4, 28.4], [122, 30.3], [121.5, 31.4],
  [120.9, 32.6], [119.8, 34.4], [120.3, 36.1], [122.5, 37.4], [121.1, 37.7],
  [119.2, 37.2], [117.8, 38.4], [117.6, 39.2], [119, 39.9], [121, 40.7],
  [121.3, 38.9], [122.3, 39.05], [123.5, 39.8], [124.4, 39.8], [125.3, 40.6],
  [126.9, 41.7], [128.1, 41.4], [129.2, 42.4], [130.7, 42.3], [131.3, 44.9],
  [133.1, 45.1], [134.7, 47.7], [134.6, 48.3], [132.6, 47.8], [130.9, 48.9],
  [129.5, 49.4], [127.8, 49.6], [126.9, 51.3], [125.9, 53], [123.6, 53.5],
  [121.5, 53.3], [119.9, 52.5], [117.8, 49.5], [115.6, 47.9], [113.6, 45],
  [111.4, 43.4], [105, 41.9], [100.9, 42.6], [96.4, 42.7], [95.9, 44.3],
  [93.5, 45], [90.9, 47.9], [87.8, 49.2], [85.5, 47.1], [83, 47.2],
  [82.1, 45.6], [79.9, 44.9], [80.4, 43.1], [76, 40.5],
];

const MAP_CFG = { minLng: 73, maxLng: 135.5, minLat: 17.5, maxLat: 54.5, w: 800, h: 570 };

function mapXY(lat, lng) {
  const x = (lng - MAP_CFG.minLng) / (MAP_CFG.maxLng - MAP_CFG.minLng) * MAP_CFG.w;
  const y = (MAP_CFG.maxLat - lat) / (MAP_CFG.maxLat - MAP_CFG.minLat) * MAP_CFG.h;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

/* Смещения подписей, чтобы плотные города не слипались: [dx, dy, anchor] */
const LABEL_POS = {
  shanghai: [11, 5],
  suzhou: [-10, -6, 'end'],
  zhujiajiao: [8, 18],
  hangzhou: [-10, 12, 'end'],
  nanjing: [10, -4],
  huangshan: [-10, 6, 'end'],
  beijing: [11, 2],
  xian: [10, -4],
  chengdu: [-10, -6, 'end'],
  chongqing: [11, 12],
  guilin: [10, -4],
  zhangjiajie: [-10, -8, 'end'],
  guangzhou: [-12, 4, 'end'],
  shenzhen: [11, 10],
};

function renderMap() {
  const wrap = document.getElementById('chinaMap');
  if (!wrap) return;

  const outline = CHINA_OUTLINE.map(([lng, lat]) => mapXY(lat, lng).join(',')).join(' ');
  const route = lastRoute;
  const roundTrip = state.settings.cityIn === state.settings.cityOut && route.length > 1;

  // линии маршрута (слегка изогнутые дуги)
  let lines = '';
  const drawLeg = (a, b) => {
    const A = mapXY(cityById[a].lat, cityById[a].lng);
    const B = mapXY(cityById[b].lat, cityById[b].lng);
    const mx = (A[0] + B[0]) / 2;
    const my = (A[1] + B[1]) / 2;
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const bow = 0.12;
    const cx = mx - dy * bow;
    const cy = my + dx * bow;
    const mode = getTransfer(a, b).mode;
    lines += `<path class="map-route ${mode === 'plane' ? 'plane' : 'ground'}"
      d="M ${A[0]} ${A[1]} Q ${cx} ${cy} ${B[0]} ${B[1]}"/>`;
  };
  for (let i = 1; i < route.length; i++) drawLeg(route[i - 1], route[i]);
  if (roundTrip) drawLeg(route[route.length - 1], route[0]);

  // точки и подписи
  let dots = '';
  CITIES.forEach((c) => {
    const [x, y] = mapXY(c.lat, c.lng);
    const sel = state.selected.has(c.id);
    dots += `<circle class="map-dot ${sel ? 'sel' : ''}" data-id="${c.id}"
      cx="${x}" cy="${y}" r="${sel ? 7 : 4.5}" tabindex="0"
      aria-label="${c.name}${sel ? ', в маршруте' : ''}"/>`;
    if (sel) {
      const [dx, dy, anchor] = LABEL_POS[c.id] || [10, 4];
      dots += `<text class="map-label" x="${x + dx}" y="${y + dy}"
        text-anchor="${anchor || 'start'}">${c.name}</text>`;
    }
  });

  wrap.innerHTML = `
    <svg viewBox="0 0 ${MAP_CFG.w} ${MAP_CFG.h}" xmlns="http://www.w3.org/2000/svg">
      <polygon class="china-land" points="${outline}"/>
      ${lines}
      ${dots}
    </svg>`;

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

/* ---------- Общий рендер ---------- */

function update() {
  ensureCoreCities();
  autoTrim();
  saveState();
  renderSettings();
  renderCityPicker();
  renderItinerary();
  renderMap();
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
  setupNav();
  setupTabs();
  update();
});
