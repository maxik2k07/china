/* ============================================================
   Конструктор маршрута:
   даты + город прилёта/вылета + люди + выбор городов → план
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
};

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
    }
  } catch (e) { /* повреждённые данные — по умолчанию */ }
}

function saveState() {
  try {
    localStorage.setItem('chinaTripState', JSON.stringify({
      selected: [...state.selected],
      settings: state.settings,
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
  if (!arrive || !depart) return true; // не заполнены — не ошибка
  return new Date(depart) > new Date(arrive);
}

function isLockedCity(id) {
  return id === state.settings.cityIn || id === state.settings.cityOut;
}

/** Города прилёта и вылета всегда в маршруте */
function ensureCoreCities() {
  state.selected.add(state.settings.cityIn);
  state.selected.add(state.settings.cityOut);
}

/** Если дней стало меньше, убираем города с низким приоритетом */
function autoTrim() {
  const days = tripDays();
  let trimmed = [];
  while (minDaysSum([...state.selected]) > days) {
    const removable = [...state.selected]
      .filter((id) => !isLockedCity(id))
      .sort((a, b) => cityById[a].priority - cityById[b].priority);
    if (!removable.length) break;
    state.selected.delete(removable[0]);
    trimmed.push(cityById[removable[0]].name);
  }
  if (trimmed.length) {
    flashMessage(`Дней стало меньше — из маршрута убраны: ${trimmed.join(', ')}`);
  }
}

/* ---------- Расчёт маршрута ---------- */

function minDaysSum(ids) {
  return ids.reduce((s, id) => s + cityById[id].min, 0);
}

function allocateDays(ids) {
  const total = tripDays();
  const alloc = {};
  ids.forEach((id) => (alloc[id] = cityById[id].min));
  let remaining = total - minDaysSum(ids);

  const byPriority = [...ids].sort((a, b) => cityById[b].priority - cityById[a].priority);
  for (const stage of ['ideal', 'max']) {
    for (const id of byPriority) {
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

/* Стоимость переезда для оптимизации: цена билета + «цена» времени в пути.
   Час в дороге условно оцениваем в 120 ¥; перелёту добавляем 3 часа
   на дорогу в аэропорт, досмотр и ожидание. */

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
  if (t.mode === 'plane') hours += 3;
  const cost = price + hours * 120;
  costCache.set(key, cost);
  return cost;
}

/** Оптимальный порядок: старт — город прилёта, финиш — город вылета.
    Перебираем все перестановки промежуточных городов и берём самый
    дешёвый по деньгам и времени вариант. */
function orderCities(ids) {
  const { cityIn, cityOut } = state.settings;
  const middle = ids.filter((id) => id !== cityIn && id !== cityOut);
  const roundTrip = cityIn === cityOut;

  if (middle.length > 8) return nnOrder(ids); // страховка от взрыва перестановок

  let best = null;
  let bestCost = Infinity;

  const permute = (rest, path, cost) => {
    if (cost >= bestCost) return; // отсечение заведомо худших веток
    if (!rest.length) {
      let total = cost;
      const last = path[path.length - 1];
      if (!roundTrip) total += transferCost(last, cityOut);
      else if (path.length > 1) total += transferCost(last, cityIn); // обратно к вылету
      if (total < bestCost) {
        bestCost = total;
        best = roundTrip ? [...path] : [...path, cityOut];
      }
      return;
    }
    const last = path[path.length - 1];
    for (let i = 0; i < rest.length; i++) {
      const next = rest[i];
      permute(
        [...rest.slice(0, i), ...rest.slice(i + 1)],
        [...path, next],
        cost + transferCost(last, next)
      );
    }
  };

  permute(middle, [cityIn], 0);
  return best || (roundTrip ? [cityIn] : [cityIn, cityOut]);
}

/** Запасной вариант — «ближайший сосед» по координатам */
function nnOrder(ids) {
  const { cityIn, cityOut } = state.settings;
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
  if (cityOut !== cityIn) route.push(cityOut);
  return route;
}

/** Примерная стоимость переездов на всех человек */
function transportBudget(route) {
  let sum = 0;
  for (let i = 1; i < route.length; i++) {
    const t = getTransfer(route[i - 1], route[i]);
    const n = parseInt(String(t.price).replace(/\D+/g, ''), 10);
    if (!isNaN(n)) sum += n;
  }
  // обратный переезд, если вылет из города прилёта
  const { cityIn, cityOut } = state.settings;
  if (cityIn === cityOut && route.length > 1) {
    const t = getTransfer(route[route.length - 1], cityIn);
    const n = parseInt(String(t.price).replace(/\D+/g, ''), 10);
    if (!isNaN(n)) sum += n;
  }
  return sum * state.settings.people;
}

/* ---------- Форматирование дат ---------- */

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

function peopleWord(n) {
  if (n === 1) return 'путешественник';
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'путешественника';
  return 'путешественников';
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
  } else {
    const next = [...state.selected, id];
    if (minDaysSum(next) > tripDays()) {
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

/* ---------- Рендер: маршрут ---------- */

function renderItinerary() {
  const ids = [...state.selected];
  const { alloc, unused } = allocateDays(ids);
  const route = orderCities(ids);
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
    ? `Осталось ${unused} свободных ${dayWord(unused)} — добавьте город или оставьте на отдых.`
    : 'Все дни распределены.';

  const budget = transportBudget(route);
  document.getElementById('budgetLine').textContent = budget
    ? `Переезды между городами: ≈ ${budget.toLocaleString('ru-RU')} ¥ на ${s.people} ${peopleWord(s.people)} (~${Math.round(budget * 12).toLocaleString('ru-RU')} ₽)`
    : '';

  const wrap = document.getElementById('itinerary');
  let html = '';
  let dayNum = 0;

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

    html += `
      <div class="city-block">
        <div class="city-block-header">
          <img src="${city.image}" alt="${city.name}" loading="lazy" onerror="this.style.display='none'">
          <div class="city-block-overlay"></div>
          <div class="city-block-title">
            <div>
              <h3>${city.name} <span class="cn">${city.cn}</span></h3>
              <p>${days} ${dayWord(days)} · ${city.tagline}</p>
            </div>
          </div>
        </div>`;

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
        Оставьте запас на отдых и шопинг — или добавьте ещё один город выше.</div>
      </div>`;
  }

  // возвращение домой
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

function update() {
  ensureCoreCities();
  autoTrim();
  saveState();
  renderSettings();
  renderCityPicker();
  renderItinerary();
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
