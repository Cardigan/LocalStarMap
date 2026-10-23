import { catalog, referenceStars, directionSets } from './data.js';
import { DEG, clamp, subtract, length, smooth, angleDelta, positionFromEquatorial, toGalactic, orbitCamera, anglesFor, cameraBasis, project, apparentMagnitude, directionMarker, arrivalPulse, flightFrame } from './space.js';

const $ = id => document.getElementById(id);
const canvas = $('sky');
const ctx = canvas.getContext('2d');
const overview = $('overview');
const mini = overview.getContext('2d');
const stars = [...catalog, ...referenceStars].map(star => {
  const position = positionFromEquatorial(star.ra, star.dec, star.distance);
  return { ...star, position, mapPosition: toGalactic(position) };
});
const sol = stars.find(star => star.id === 'sol');
const alpha = stars.find(star => star.catalogName === 'Alpha Centauri');
const displayName = star => star.id === alpha.id ? 'Alpha Centauri' : star.name;
const navigation = star => star === sol || star === alpha;
const normalize = text => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const state = {
  observer: [...sol.position], location: sol, selected: alpha, ...anglesFor(alpha.position),
  fov: 90, grid: true, labels: true, directions: true, tab: 'prominent', marks: new Set(),
  rawHighlights: '', flight: null, focus: null, hover: null, route: { from: sol, to: alpha },
  view: 'sky', orbit: { yaw: .75, pitch: .26, distance: 165, extent: 50, target: [0, 0, 0] }
};
let width = 0, height = 0, dpr = 1, dirty = true, projected = [], palette = {}, exclusions = [];
let pointer = null, lastTime = 0, uiElapsed = 0;
let canvasClickTimer = null, markerClickTimer = null, lastCanvasClick = null;
let markerButtons = [];

function activeDirections() {
  return state.view === 'sky' && state.directions && !state.flight ? directionSets[state.location.id] || [] : [];
}

function directional(star) {
  return activeDirections().some(marker => marker.starId === star.id);
}

try {
  const saved = JSON.parse(localStorage.getItem('nearspace-highlights') || '{}');
  state.marks = new Set((Array.isArray(saved.ids) ? saved.ids : []).filter(id => stars.some(star => star.id === id)));
  state.rawHighlights = typeof saved.raw === 'string' ? saved.raw : '';
} catch { /* Storage can be unavailable for local files or private browsing. */ }

function persistMarks() {
  try {
    localStorage.setItem('nearspace-highlights', JSON.stringify({ ids: [...state.marks], raw: state.rawHighlights }));
    return true;
  } catch {
    return false;
  }
}

function readPalette() {
  const css = getComputedStyle(document.documentElement);
  for (const key of ['surface', 'surface-soft', 'text', 'text-muted', 'text-soft', 'border', 'accent', 'accent-soft', 'warning', 'success']) {
    palette[key] = css.getPropertyValue(`--cp-${key}`).trim();
  }
  dirty = true;
}

function starColor(star) {
  if (navigation(star)) return palette.accent;
  if (state.marks.has(star.id)) return palette.warning;
  if (directional(star)) return palette.accent;
  return palette.text;
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const miniRect = overview.getBoundingClientRect();
  overview.width = Math.round(miniRect.width * dpr);
  overview.height = Math.round(miniRect.height * dpr);
  mini.setTransform(dpr, 0, 0, dpr, 0, 0);
  exclusions = ['.selection-card', '.view-heading', '.map-controls', '.flight-dock', '.neighborhood', '.map-legend', '.external-note', '.zoom-controls'].map(selector => {
    const box = document.querySelector(selector).getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return { selector, x: box.left - rect.left - 8, y: box.top - rect.top - 8, w: box.width + 16, h: box.height + 16 };
  }).filter(Boolean);
  dirty = true;
}

function renderList() {
  const query = normalize($('search').value);
  let list = stars.filter(star => {
    const matches = normalize(`${star.catalogName} ${star.name} ${star === sol ? 'Earth Sun' : ''}`).includes(query);
    return matches && (query || state.tab !== 'highlighted' || state.marks.has(star.id));
  });
  if (!query && state.tab === 'prominent') {
    list = list.filter(star => star !== sol && !star.supplemental).sort((a, b) => a.magnitude - b.magnitude).slice(0, 15);
  } else {
    list.sort((a, b) => a.distance - b.distance);
  }
  $('star-list').replaceChildren();
  for (const star of list) {
    const button = document.createElement('button');
    button.className = `star-row${state.selected === star ? ' selected' : ''}${navigation(star) ? ' navigation' : ''}${state.marks.has(star.id) ? ' marked' : ''}`;
    button.dataset.starId = star.id;
    button.setAttribute('aria-label', `${displayName(star)}, ${star.distance.toFixed(2)} light-years from Earth. Select to locate; double-click to fly.`);
    button.setAttribute('aria-pressed', String(state.selected === star));
    const symbol = document.createElement('span');
    symbol.className = 'star-symbol';
    symbol.textContent = navigation(star) ? '\u2727' : state.marks.has(star.id) ? '\u2726' : '\u00b7';
    const name = document.createElement('span');
    name.className = 'row-name';
    const strong = document.createElement('strong');
    strong.textContent = displayName(star);
    const small = document.createElement('small');
    small.textContent = star.supplemental ? `Distant reference \u00b7 ${star.catalogName}` : star === alpha ? 'Our neighboring system' : star === sol ? 'Earth / home system' : star.catalogName === star.name ? star.spectral : star.catalogName;
    name.append(strong, small);
    const distance = document.createElement('span');
    distance.className = 'row-distance';
    distance.textContent = star.distance.toFixed(2);
    button.append(symbol, name, distance);
    button.addEventListener('click', () => selectStar(star));
    button.addEventListener('dblclick', () => beginFlight(star));
    $('star-list').append(button);
  }
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = query ? 'No matching stars in this catalog.' : 'Your stars, your constellation. Add highlights below to start a list.';
    $('star-list').append(empty);
  }
  $('marked-count').textContent = state.marks.size;
  $('list-heading').textContent = query ? `${list.length} MATCHING SYSTEMS` : state.tab === 'prominent' ? 'BRIGHTEST FROM EARTH' : state.tab === 'highlighted' ? 'YOUR HIGHLIGHTED STARS' : 'NEAREST FIRST';
  $('star-list').setAttribute('aria-labelledby', `tab-${state.tab}`);
}

function updateListSelection() {
  for (const button of $('star-list').querySelectorAll('.star-row')) {
    const selected = button.dataset.starId === state.selected.id;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function updateSelection() {
  const star = state.selected;
  const distance = length(subtract(star.position, state.observer));
  $('selected-name').textContent = displayName(star);
  $('selected-alias').textContent = star === alpha ? alpha.name : star === sol ? 'Earth / our home system' : star.name === star.catalogName ? 'Nearby stellar system' : star.catalogName;
  $('selected-distance').innerHTML = `${star.distance.toFixed(2)} <small>ly</small>`;
  $('selected-relative').innerHTML = `${distance.toFixed(2)} <small>ly</small>`;
  $('selected-spectral').textContent = star.spectral.split('+').join(' + ');
  const components = star.spectral.split('+').length;
  $('selected-kind').textContent = components === 1 ? 'Single star' : components === 2 ? 'Binary system' : components === 3 ? 'Triple system' : 'Multiple system';
  $('selection-kicker').textContent = star.supplemental ? 'DISTANT DIRECTION REFERENCE' : navigation(star) ? 'NAVIGATION TARGET' : 'CATALOG IN FOCUS';
  $('mark-star').textContent = state.marks.has(star.id) ? '\u2605' : '\u2606';
  $('mark-star').setAttribute('aria-pressed', String(state.marks.has(star.id)));
  const atStar = distance < .025;
  $('selection-action').disabled = Boolean(state.flight) || atStar;
  $('selection-action').textContent = atStar ? 'Your current system' : `Fly to ${star === sol ? 'Earth / Sol' : displayName(star)} \u2197`;
}

function focusStar(star, immediate = false) {
  if (state.view === 'external') {
    if (star.distance > state.orbit.extent) {
      state.orbit.extent = star.distance;
      state.orbit.distance = star.distance * 3.3;
    }
    state.orbit.target = [...star.mapPosition];
    updateZoomLabel();
    dirty = true;
    return;
  }
  const vector = subtract(star.position, state.observer);
  if (length(vector) < .025 || state.flight) return;
  const target = anglesFor(vector);
  if (immediate || reducedMotion.matches) {
    state.yaw = target.yaw;
    state.pitch = target.pitch;
    state.focus = null;
  } else {
    state.focus = { fromYaw: state.yaw, fromPitch: state.pitch, toYaw: state.yaw + angleDelta(state.yaw, target.yaw), toPitch: target.pitch, elapsed: 0 };
  }
  dirty = true;
}

function selectStar(star, autoTravel = true) {
  if (state.flight) return;
  state.selected = star;
  $('catalog-panel').classList.remove('open');
  $('catalog-toggle').setAttribute('aria-expanded', 'false');
  if (state.view === 'sky' && autoTravel && navigation(star) && star !== state.location) {
    beginFlight(star);
    return;
  }
  focusStar(star);
  updateListSelection();
  updateSelection();
  $('announcement').textContent = `${displayName(star)} selected. ${star.distance.toFixed(2)} light-years from Earth.`;
  dirty = true;
}

function updateLocationUI() {
  const destination = state.location === sol ? alpha : sol;
  $('observer-title').textContent = state.location === sol ? 'Earth / Sol' : displayName(state.location);
  $('observer-subtitle').textContent = `${state.location === sol ? 'At home.' : `${state.location.distance.toFixed(2)} light-years from Earth.`} Looking toward ${displayName(state.selected)}.`;
  $('fly-button').textContent = state.location === sol ? 'Begin journey \u2192' : 'Return to Earth \u2192';
  $('flight-status').textContent = state.location === state.route.from ? 'Ready for departure' : 'Arrived. Looking back.';
  $('route-start-dot').classList.toggle('active', state.location === state.route.from);
  $('route-end-dot').classList.toggle('active', state.location === state.route.to);
  $('route-progress').style.width = state.location === state.route.to ? '100%' : '0%';
  $('route-ship').style.left = state.location === state.route.to ? '100%' : '0%';
  $('reset-button').title = `Look toward ${displayName(destination)}`;
  $('skip-button').hidden = true;
  updateSelection();
  updateDirectionButtons();
  updateViewUI();
}

function updateZoomLabel() {
  $('fov-label').textContent = state.view === 'external'
    ? `${(state.orbit.extent * 3.3 / state.orbit.distance).toFixed(1)}x`
    : `${Math.round(state.fov)}\u00b0`;
}

function updateViewUI() {
  const external = state.view === 'external';
  $('map').dataset.view = state.view;
  $('perspective-mode').textContent = external ? 'EXTERNAL 3D VIEW' : 'LIVE PERSPECTIVE';
  $('sky-view-button').hidden = !external;
  $('directions-toggle').hidden = external;
  $('external-note').hidden = !external;
  $('neighborhood-button').setAttribute('aria-pressed', String(external));
  $('neighborhood-button').setAttribute('aria-label', external ? 'Return to observer sky view' : 'Open external 3D neighborhood view');
  $('neighborhood-button').title = external ? 'Return to your observer without moving it' : 'Click to explore the neighborhood from outside';
  $('overview-caption').textContent = external ? 'Return to sky' : 'Explore in 3D';
  $('overview-action').textContent = external ? 'Return \u2199' : 'Open \u2197';
  $('interaction-hints').textContent = `DRAG TO ${external ? 'ORBIT' : 'LOOK'} / SCROLL TO ZOOM / DOUBLE-CLICK TO FLY`;
  canvas.setAttribute('aria-label', `Interactive 3D star map. Drag to ${external ? 'orbit the neighborhood' : 'look around'}, scroll to zoom, or use arrow keys. Double-click a star to fly there. The selected-star Fly button is a keyboard and touch alternative.`);
  if (external) {
    $('observer-title').textContent = 'Solar neighborhood';
    $('observer-subtitle').textContent = `Orbiting the stars. Observer remains at ${displayName(state.location)}${state.flight ? ' (in flight)' : ''}.`;
    $('reset-button').title = 'Fit the neighborhood around Sol';
  } else if (state.flight) {
    $('observer-title').textContent = 'Between the stars';
    $('observer-subtitle').textContent = `En route to ${displayName(state.flight.destination)}`;
  } else {
    $('observer-title').textContent = state.location === sol ? 'Earth / Sol' : displayName(state.location);
    $('observer-subtitle').textContent = `${state.location === sol ? 'At home.' : `${state.location.distance.toFixed(2)} light-years from Earth.`} Looking toward ${displayName(state.selected)}.`;
    $('reset-button').title = `Look toward ${displayName(state.location === sol ? alpha : sol)}`;
  }
  updateZoomLabel();
}

function resetOrbit() {
  const extent = Math.max(50, length(state.observer), state.route.from.distance, state.route.to.distance);
  state.orbit = { yaw: .75, pitch: .26, distance: extent * 3.3, extent, target: [0, 0, 0] };
  updateZoomLabel();
  dirty = true;
}

function setView(view) {
  clearTimeout(canvasClickTimer);
  clearTimeout(markerClickTimer);
  lastCanvasClick = null;
  pointer = null;
  canvas.classList.remove('dragging');
  state.focus = null;
  state.hover = null;
  $('tooltip').hidden = true;
  state.view = view;
  if (view === 'external' && Math.max(50, length(state.observer), state.route.from.distance, state.route.to.distance) > state.orbit.extent) resetOrbit();
  updateViewUI();
  updateDirectionButtons();
  resize();
  $('announcement').textContent = view === 'external'
    ? 'External neighborhood view. Drag or use arrow keys to orbit; scroll to zoom. Sky view returns to your observer.'
    : `Returned to the sky at ${displayName(state.location)}.`;
  canvas.focus({ preventScroll: true });
  dirty = true;
}

function updateRouteUI() {
  for (const [end, star] of [['start', state.route.from], ['end', state.route.to]]) {
    $(`route-${end}-name`).textContent = star === sol ? 'Earth' : displayName(star);
    $(`route-${end}-detail`).textContent = star === sol ? 'SOL SYSTEM' : star.name === star.catalogName ? star.spectral : star.name;
  }
  $('route-distance').textContent = `${length(subtract(state.route.to.position, state.route.from.position)).toFixed(2)} LIGHT-YEARS`;
  $('route-progress').style.width = '0%';
  $('route-ship').style.left = '0%';
}

function beginFlight(destination) {
  if (state.flight || state.location === destination) return;
  if (state.view === 'external') setView('sky');
  clearTimeout(canvasClickTimer);
  clearTimeout(markerClickTimer);
  pointer = null;
  canvas.classList.remove('dragging');
  state.focus = null;
  state.hover = null;
  $('tooltip').hidden = true;
  state.selected = destination;
  state.flight = {
    from: [...state.observer], to: [...destination.position], destination, origin: state.location,
    startAngles: { yaw: state.yaw, pitch: state.pitch }, elapsed: 0, paused: false,
    travelDuration: reducedMotion.matches ? 700 : 8000,
    turnDuration: reducedMotion.matches ? 300 : 2600
  };
  $('map').dataset.flying = 'true';
  state.route = { from: state.location, to: destination };
  updateRouteUI();
  updateDirectionButtons();
  $('fly-button').textContent = 'Pause flight \u2161';
  $('observer-title').textContent = 'Between the stars';
  $('observer-subtitle').textContent = `En route to ${destination === sol ? 'Earth / Sol' : displayName(destination)}`;
  $('skip-button').hidden = false;
  $('flight-status').textContent = 'Departing \u00b7 cinematic flight';
  $('announcement').textContent = `Flying to ${displayName(destination)}. On arrival, the camera will turn to look back.`;
  updateListSelection();
  updateSelection();
  dirty = true;
}

function finishFlight() {
  const flight = state.flight;
  if (!flight) return;
  const final = flightFrame(flight.from, flight.to, flight.startAngles, flight.travelDuration + flight.turnDuration, flight.travelDuration, flight.turnDuration);
  state.observer = [...flight.to];
  state.yaw = final.yaw;
  state.pitch = final.pitch;
  state.location = flight.destination;
  state.selected = flight.origin;
  state.flight = null;
  $('map').dataset.flying = 'false';
  updateLocationUI();
  updateListSelection();
  $('announcement').textContent = `Arrived at ${displayName(state.location)}. Looking back toward ${displayName(state.selected)}.`;
  dirty = true;
}

function circle(context, x, y, radius) {
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
}

function drawGrid(basis) {
  ctx.strokeStyle = palette.border;
  ctx.lineWidth = .65;
  ctx.globalAlpha = .42;
  const point = (ra, dec) => project(positionFromEquatorial(ra, dec, 1), [0, 0, 0], basis, width, height, state.fov);
  function line(coordinates) {
    ctx.beginPath();
    let previous = null;
    for (const [ra, dec] of coordinates) {
      const p = point(ra, dec);
      if (!p || Math.abs(p.x) > width * 3 || Math.abs(p.y) > height * 3) { previous = null; continue; }
      if (previous) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      previous = p;
    }
    ctx.stroke();
  }
  for (let dec = -75; dec <= 75; dec += 15) {
    line(Array.from({ length: 181 }, (_, i) => [i * 2, dec]));
  }
  for (let ra = 0; ra < 360; ra += 30) {
    line(Array.from({ length: 91 }, (_, i) => [ra, -90 + i * 2]));
  }
  ctx.globalAlpha = .65;
  ctx.fillStyle = palette['text-muted'];
  ctx.font = '8px Consolas, "Courier New", monospace';
  for (let ra = 0; ra < 360; ra += 30) {
    const p = point(ra, 0);
    if (p && p.x > 10 && p.x < width - 60 && p.y > 145 && p.y < height - 170) ctx.fillText(`${String(ra / 15).padStart(2, '0')}h / 0\u00b0`, p.x + 5, p.y - 7);
  }
  ctx.globalAlpha = 1;
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function drawSky() {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = palette.surface;
  ctx.fillRect(0, 0, width, height);
  const basis = cameraBasis(state.yaw, state.pitch);
  if (state.grid) drawGrid(basis);
  projected = [];
  for (const star of stars) {
    const p = project(star.position, state.observer, basis, width, height, state.fov);
    if (!p || p.distance < .025 || p.x < -30 || p.x > width + 30 || p.y < -30 || p.y > height + 30) continue;
    const magnitude = apparentMagnitude(star.absoluteMagnitude, p.distance);
    const radius = clamp(3.5 - magnitude * .37, .85, 7);
    projected.push({ ...p, star, radius, magnitude });
  }
  projected.sort((a, b) => b.distance - a.distance);
  for (const p of projected) {
    const color = starColor(p.star);
    const isTarget = navigation(p.star);
    const selected = p.star === state.selected;
    const hovered = p.star === state.hover;
    ctx.fillStyle = color;
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius * (isTarget ? 10 : 5));
    glow.addColorStop(0, color);
    glow.addColorStop(1, palette.surface);
    ctx.globalAlpha = isTarget ? .19 : .085;
    ctx.fillStyle = glow;
    circle(ctx, p.x, p.y, p.radius * (isTarget ? 10 : 5));
    ctx.fill();
    ctx.globalAlpha = clamp(.95 - Math.max(0, p.magnitude - 2) * .1, .32, 1);
    ctx.fillStyle = color;
    circle(ctx, p.x, p.y, isTarget ? Math.max(p.radius, 3.2) : p.radius);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (isTarget || selected || hovered || directional(p.star) || state.marks.has(p.star.id)) {
      ctx.strokeStyle = color;
      ctx.lineWidth = .8;
      ctx.globalAlpha = selected || hovered ? .85 : .45;
      circle(ctx, p.x, p.y, selected ? 17 : 10);
      ctx.stroke();
      if (isTarget) {
        ctx.globalAlpha = .65;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a = i * Math.PI / 2;
          ctx.moveTo(p.x + Math.cos(a) * 21, p.y + Math.sin(a) * 21);
          ctx.lineTo(p.x + Math.cos(a) * 26, p.y + Math.sin(a) * 26);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
  const occupied = [...exclusions];
  const labels = [...projected].sort((a, b) => {
    const priority = p => (p.star === state.selected ? 100 : 0) + (navigation(p.star) ? 50 : 0) + (state.marks.has(p.star.id) ? 20 : 0) - p.magnitude;
    return priority(b) - priority(a);
  });
  for (const p of labels) {
    if (directional(p.star)) continue;
    const important = navigation(p.star) || p.star === state.selected || state.marks.has(p.star.id);
    if (!state.labels && !important) continue;
    if (!important && p.magnitude > 5.5) continue;
    const name = displayName(p.star);
    ctx.font = important ? '500 13px "Segoe UI", sans-serif' : '10px "Segoe UI", sans-serif';
    const w = ctx.measureText(name).width + 8;
    const offset = important ? 32 : 10;
    let box = null;
    for (const [dx, dy] of [[offset, -5], [-w - offset, -5], [offset, 17], [-w - offset, 17]]) {
      const candidate = { x: p.x + dx, y: p.y + dy - 11, w, h: important ? 33 : 18 };
      if (candidate.x < 6 || candidate.x + w > width - 6 || candidate.y < 6 || candidate.y + candidate.h > height - 42) continue;
      if (!occupied.some(other => overlaps(candidate, other))) { box = candidate; break; }
    }
    if (!box) continue;
    occupied.push(box);
    ctx.fillStyle = important ? starColor(p.star) : palette['text-soft'];
    ctx.globalAlpha = important ? 1 : .8;
    ctx.fillText(name, box.x + 2, box.y + 12);
    if (important) {
      ctx.font = '8px Consolas, "Courier New", monospace';
      ctx.fillStyle = palette['text-muted'];
      ctx.fillText(`${p.distance.toFixed(2)} LY FROM YOU`, box.x + 2, box.y + 26);
    }
    ctx.globalAlpha = 1;
  }
  positionDirectionButtons(basis);
  drawArrivalRing(basis);
  $('visible-count').textContent = `${projected.length} IN VIEW  /  J2000`;
  drawOverview();
}

function updateDirectionButtons() {
  $('direction-markers').replaceChildren();
  markerButtons = activeDirections().map(reference => {
    const star = stars.find(item => item.id === reference.starId);
    const button = document.createElement('button');
    button.className = 'direction-marker';
    button.dataset.direction = reference.direction;
    button.dataset.starId = star.id;
    const arrow = document.createElement('span');
    arrow.className = 'marker-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    const direction = document.createElement('strong');
    direction.textContent = reference.direction;
    const name = document.createElement('small');
    name.textContent = star === sol ? 'Earth / Sol' : displayName(star);
    text.append(direction, name);
    button.append(arrow, text);
    button.addEventListener('click', () => {
      clearTimeout(markerClickTimer);
      markerClickTimer = setTimeout(() => selectStar(star, false), 280);
    });
    button.addEventListener('dblclick', () => {
      clearTimeout(markerClickTimer);
      beginFlight(star);
    });
    $('direction-markers').append(button);
    return { reference, star, button, arrow };
  });
  dirty = true;
}

function positionDirectionButtons(basis) {
  const mobile = window.innerWidth <= 1400;
  const markerWidth = mobile ? 110 : 142, markerHeight = mobile ? 35 : 39;
  const halfW = markerWidth / 2, halfH = markerHeight / 2;
  const dock = exclusions.find(box => box.selector === '.flight-dock');
  const bounds = {
    left: halfW + 12, right: width - halfW - 12,
    top: 145 + halfH, bottom: Math.max(225, (dock?.y ?? height - 32) - halfH - 12)
  };
  const occupied = [...exclusions];
  for (const { star, reference, button, arrow } of markerButtons) {
    const marker = directionMarker(star.position, state.observer, basis, width, height, state.fov, bounds);
    if (!marker) { button.hidden = true; continue; }
    button.hidden = false;
    const occluded = marker.visible && exclusions.some(box => overlaps({ x: marker.x - 3, y: marker.y - 3, w: 6, h: 6 }, box));
    const onScreen = marker.visible && !occluded;
    const offset = {
      Forward: [halfW + 22, -3], Backward: [halfW + 22, -3],
      Up: [0, -halfH - 20], Down: [0, halfH + 20],
      Left: [-halfW - 22, -3], Right: [halfW + 22, -3]
    }[reference.direction];
    let x = onScreen ? marker.x + offset[0] : marker.edgeX;
    let y = onScreen ? marker.y + offset[1] : marker.edgeY;
    x = clamp(x, bounds.left, bounds.right);
    y = clamp(y, bounds.top, bounds.bottom);
    const candidates = [];
    for (const dx of [0, -(markerWidth + 32), markerWidth + 12, -markerWidth * 2]) {
      for (const dy of [0, -46, 46, -92, 92, -138, 138, -184, 184, -230, 230]) {
        const cx = clamp(x + dx, bounds.left, bounds.right), cy = clamp(y + dy, bounds.top, bounds.bottom);
        candidates.push({ x: cx - halfW, y: cy - halfH, w: markerWidth, h: markerHeight, distance: Math.hypot(cx - x, cy - y) });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const box = candidates.find(candidate => !occupied.some(other => overlaps(candidate, other))) || candidates[0];
    occupied.push({ x: box.x - 3, y: box.y - 3, w: box.w + 6, h: box.h + 6 });
    button.style.left = `${box.x + halfW}px`;
    button.style.top = `${box.y + halfH}px`;
    button.dataset.offscreen = String(!onScreen);
    button.dataset.behind = String(marker.behind);
    button.setAttribute('aria-label', `${reference.direction}: ${displayName(star)}. ${onScreen ? 'In view.' : marker.behind ? 'Behind the camera; follow the arrow.' : 'Out of view; follow the arrow.'} Select to locate; double-click to fly.`);
    button.title = `${reference.direction}: ${displayName(star)}${marker.behind ? ' (behind camera)' : ''}`;
    arrow.textContent = onScreen ? '\u00b7' : '\u2192';
    arrow.style.transform = onScreen ? '' : `rotate(${marker.angle}rad)`;
    if (onScreen) {
      ctx.strokeStyle = palette.accent;
      ctx.lineWidth = .7;
      ctx.globalAlpha = .4;
      ctx.beginPath();
      ctx.moveTo(marker.x, marker.y);
      ctx.lineTo(clamp(marker.x, box.x, box.x + box.w), clamp(marker.y, box.y, box.y + box.h));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

function drawArrivalRing(basis) {
  const flight = state.flight;
  const pulse = flight && arrivalPulse(flight.elapsed, flight.travelDuration);
  $('arrival-ring').hidden = !pulse;
  if (!pulse) return;
  const p = project(flight.to, state.observer, basis, width, height, state.fov);
  const radius = reducedMotion.matches ? 56 : pulse.radius;
  $('arrival-ring').style.left = `${p?.x ?? width / 2}px`;
  $('arrival-ring').style.top = `${p?.y ?? height / 2}px`;
  $('arrival-ring').style.width = `${radius * 2}px`;
  $('arrival-ring').style.height = `${radius * 2}px`;
  $('arrival-ring').style.opacity = reducedMotion.matches ? .8 : pulse.opacity;
  $('arrival-ring').dataset.phase = pulse.arrived ? 'arrived' : 'approach';
  $('arrival-caption').textContent = `${pulse.arrived ? 'ARRIVED' : 'ARRIVING'} \u00b7 ${displayName(flight.destination)}`;
}

function drawExternal() {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = palette.surface;
  ctx.fillRect(0, 0, width, height);
  $('arrival-ring').hidden = true;
  const orbit = state.orbit;
  const camera = orbitCamera(orbit.target, orbit.yaw, orbit.pitch, orbit.distance);
  const point = position => project(position, camera.position, camera.basis, width, height, 42);
  function line(positions) {
    ctx.beginPath();
    let previous = null;
    for (const position of positions) {
      const p = point(position);
      if (!p) { previous = null; continue; }
      if (previous) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      previous = p;
    }
    ctx.stroke();
  }
  const step = orbit.extent <= 50 ? 10 : Math.ceil(orbit.extent / 50) * 10;
  $('external-scale').textContent = `${step} LY RINGS / SOL-CENTERED`;
  if (state.grid) {
    ctx.strokeStyle = palette['text-muted'];
    ctx.lineWidth = .75;
    ctx.globalAlpha = .45;
    ctx.font = '9px Consolas, "Courier New", monospace';
    ctx.fillStyle = palette['text-muted'];
    for (let radius = step; radius <= orbit.extent + .001; radius += step) {
      line(Array.from({ length: 121 }, (_, i) => {
        const angle = i / 120 * Math.PI * 2;
        return [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
      }));
      const p = point([radius, 0, 0]);
      if (p) ctx.fillText(`${radius} ly`, p.x + 5, p.y - 5);
    }
    ctx.setLineDash([2, 5]);
    line([[-orbit.extent, 0, 0], [orbit.extent, 0, 0]]);
    line([[0, 0, -orbit.extent], [0, 0, orbit.extent]]);
    ctx.setLineDash([]);
    ctx.globalAlpha = .7;
    for (let angle = 0; angle < 360; angle += 90) {
      const p = point(positionFromEquatorial(angle, 0, orbit.extent * 1.08));
      if (p) ctx.fillText(`${angle}\u00b0`, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }
  projected = [];
  for (const star of stars) {
    if (star.distance > orbit.extent + .001) continue;
    const p = point(star.mapPosition);
    if (!p) continue;
    const radius = clamp(3.4 - star.absoluteMagnitude * .22, 1.2, 4);
    projected.push({ ...p, star, radius });
  }
  projected.sort((a, b) => b.depth - a.depth);
  if (state.grid) {
    ctx.lineWidth = .65;
    for (const p of projected) {
      const position = p.star.mapPosition;
      const important = navigation(p.star) || state.marks.has(p.star.id) || p.star === state.selected;
      ctx.strokeStyle = important ? starColor(p.star) : palette['text-soft'];
      ctx.globalAlpha = important ? .65 : .32;
      ctx.setLineDash(position[1] < 0 ? [2, 4] : []);
      line([[position[0], 0, position[2]], position]);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 1.3;
  ctx.setLineDash([5, 4]);
  line([state.route.from.mapPosition, state.route.to.mapPosition]);
  ctx.setLineDash([]);
  projected = projected.filter(p => p.x > -20 && p.x < width + 20 && p.y > -20 && p.y < height + 20);
  for (const p of projected) {
    const important = navigation(p.star) || state.marks.has(p.star.id);
    const selected = p.star === state.selected || p.star === state.hover;
    ctx.fillStyle = starColor(p.star);
    ctx.globalAlpha = important || selected ? 1 : .85;
    circle(ctx, p.x, p.y, important ? Math.max(3, p.radius) : p.radius);
    ctx.fill();
    if (important || selected) {
      ctx.strokeStyle = starColor(p.star);
      ctx.lineWidth = selected ? 1.2 : .75;
      circle(ctx, p.x, p.y, selected ? 11 : 7);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  const observer = point(toGalactic(state.observer));
  if (observer) {
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 1.5;
    circle(ctx, observer.x, observer.y, 15);
    ctx.stroke();
    ctx.fillStyle = palette.accent;
    circle(ctx, observer.x, observer.y, 2);
    ctx.fill();
  }
  const occupied = [...exclusions];
  const labels = [...projected].sort((a, b) => {
    const priority = p => (p.star === state.selected ? 100 : 0) + (navigation(p.star) ? 50 : 0) + (state.marks.has(p.star.id) ? 20 : 0) - p.star.magnitude;
    return priority(b) - priority(a);
  });
  for (const p of labels) {
    const important = navigation(p.star) || state.marks.has(p.star.id) || p.star === state.selected || p.star === state.hover;
    if (!state.labels && !important) continue;
    const name = p.star === state.location && !state.flight ? `${p.star === sol ? 'Earth / Sol' : displayName(p.star)} (you)` : displayName(p.star);
    ctx.font = important ? '500 12px "Segoe UI", sans-serif' : '9px "Segoe UI", sans-serif';
    const w = ctx.measureText(name).width + 6, offset = important ? 19 : 8;
    let box = null;
    for (const [dx, dy] of [[offset, -7], [-w - offset, -7], [offset, 9], [-w - offset, 9]]) {
      const candidate = { x: p.x + dx, y: p.y + dy, w, h: 14 };
      if (candidate.x < 6 || candidate.x + w > width - 6 || candidate.y < 6 || candidate.y + 14 > height - 35) continue;
      if (!occupied.some(other => overlaps(candidate, other))) { box = candidate; break; }
    }
    if (!box) continue;
    occupied.push(box);
    ctx.fillStyle = important ? starColor(p.star) : palette['text-soft'];
    ctx.fillText(name, box.x + 2, box.y + 10);
  }
  $('visible-count').textContent = `${projected.length} IN VIEW / GALACTIC FRAME`;
  drawOverview();
}

function drawOverview() {
  const w = overview.width / dpr, h = overview.height / dpr;
  mini.clearRect(0, 0, w, h);
  const extent = Math.max(50, length(state.observer), length(state.route.from.position), length(state.route.to.position));
  const factor = Math.min(w / (extent * 2.3), h / (extent * 1.7));
  $('overview-range').textContent = `${Math.ceil(extent)} LY`;
  const iso = position => ({
    x: w / 2 + (position[0] * .82 - position[2] * .57) * factor,
    y: h / 2 + (position[0] * .22 + position[2] * .32 - position[1] * .8) * factor
  });
  mini.strokeStyle = palette.border;
  mini.lineWidth = .65;
  for (const radius of [.3, .6, 1].map(fraction => fraction * extent)) {
    mini.beginPath();
    for (let i = 0; i <= 80; i++) {
      const angle = i / 80 * Math.PI * 2;
      const p = iso([Math.cos(angle) * radius, 0, Math.sin(angle) * radius]);
      if (i) mini.lineTo(p.x, p.y); else mini.moveTo(p.x, p.y);
    }
    mini.stroke();
  }
  for (const star of stars) {
    if (length(star.position) > extent) continue;
    const p = iso(star.position);
    mini.fillStyle = starColor(star);
    mini.globalAlpha = navigation(star) || state.marks.has(star.id) ? 1 : .4;
    circle(mini, p.x, p.y, navigation(star) ? 2 : 1);
    mini.fill();
  }
  mini.globalAlpha = 1;
  const home = iso(state.route.from.position), destination = iso(state.route.to.position), observer = iso(state.observer);
  mini.beginPath();
  mini.moveTo(home.x, home.y);
  mini.lineTo(destination.x, destination.y);
  mini.strokeStyle = palette.accent;
  mini.lineWidth = 1.5;
  mini.stroke();
  circle(mini, observer.x, observer.y, 5);
  mini.stroke();
  mini.fillStyle = palette.accent;
  circle(mini, observer.x, observer.y, 1.8);
  mini.fill();
}

function animate(time) {
  const delta = lastTime ? Math.min(time - lastTime, 100) : 0;
  lastTime = time;
  if (state.flight && !state.flight.paused) {
    const flight = state.flight;
    flight.elapsed += delta;
    const frame = flightFrame(flight.from, flight.to, flight.startAngles, flight.elapsed, flight.travelDuration, flight.turnDuration);
    state.observer = frame.position;
    state.yaw = frame.yaw;
    state.pitch = frame.pitch;
    const progress = frame.progress;
    $('route-progress').style.width = `${progress * 100}%`;
    $('route-ship').style.left = `${progress * 100}%`;
    uiElapsed += delta;
    if (uiElapsed > 100) {
      updateSelection();
      $('flight-status').textContent = frame.turning ? 'Arrived \u00b7 turning back' : `${length(subtract(flight.to, state.observer)).toFixed(2)} ly to arrival`;
      uiElapsed = 0;
    }
    dirty = true;
    if (frame.done) finishFlight();
  } else if (state.focus) {
    const focus = state.focus;
    focus.elapsed += delta;
    const t = smooth(clamp(focus.elapsed / 850, 0, 1));
    state.yaw = focus.fromYaw + (focus.toYaw - focus.fromYaw) * t;
    state.pitch = focus.fromPitch + (focus.toPitch - focus.fromPitch) * t;
    if (t === 1) state.focus = null;
    dirty = true;
  }
  if (dirty && width && height) {
    if (state.view === 'external') drawExternal(); else drawSky();
    dirty = false;
  }
  requestAnimationFrame(animate);
}

function hitTest(x, y) {
  return [...projected].filter(p => Math.hypot(p.x - x, p.y - y) < Math.max(12, p.radius + 7))
    .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0]?.star || null;
}

canvas.addEventListener('pointerdown', event => {
  if ((state.flight && state.view === 'sky') || (event.pointerType === 'mouse' && event.button !== 0)) return;
  state.focus = null;
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0 };
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', event => {
  if (pointer && pointer.id === event.pointerId) {
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    pointer.distance += Math.hypot(dx, dy);
    pointer.x = event.clientX; pointer.y = event.clientY;
    if (state.view === 'external') {
      state.orbit.yaw -= dx * .005;
      state.orbit.pitch = clamp(state.orbit.pitch + dy * .005, -1.5, 1.5);
    } else {
      state.yaw += dx * .0035 * state.fov / 90;
      state.pitch = clamp(state.pitch + dy * .0035 * state.fov / 90, -Math.PI / 2 + .001, Math.PI / 2 - .001);
    }
    $('tooltip').hidden = true;
    dirty = true;
  } else if (!state.flight) {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const star = hitTest(x, y);
    if (state.hover !== star) { state.hover = star; dirty = true; }
    canvas.style.cursor = star ? 'pointer' : 'grab';
    $('tooltip').hidden = !star;
    if (star) {
      $('tooltip').textContent = `${displayName(star)} \u00b7 ${length(subtract(star.position, state.observer)).toFixed(2)} ly from you`;
      $('tooltip').style.left = `${clamp(x + 15, 8, Math.max(8, width - 245))}px`;
      $('tooltip').style.top = `${clamp(y + 15, 8, height - 80)}px`;
    }
  }
});
canvas.addEventListener('pointerup', event => {
  if (!pointer || pointer.id !== event.pointerId) return;
  if (pointer.distance < 6) {
    const rect = canvas.getBoundingClientRect();
    const recent = lastCanvasClick && performance.now() - lastCanvasClick.time < 650 && Math.hypot(event.clientX - lastCanvasClick.x, event.clientY - lastCanvasClick.y) < 16;
    const star = recent ? lastCanvasClick.star : hitTest(event.clientX - rect.left, event.clientY - rect.top);
    if (star) {
      clearTimeout(canvasClickTimer);
      lastCanvasClick = { star, x: event.clientX, y: event.clientY, time: performance.now() };
      canvasClickTimer = setTimeout(() => selectStar(star, state.view === 'sky'), 280);
    }
  }
  pointer = null;
  canvas.classList.remove('dragging');
  canvas.releasePointerCapture(event.pointerId);
});
canvas.addEventListener('dblclick', event => {
  if (state.flight) return;
  clearTimeout(canvasClickTimer);
  const rect = canvas.getBoundingClientRect();
  const recent = lastCanvasClick && performance.now() - lastCanvasClick.time < 650 && Math.hypot(event.clientX - lastCanvasClick.x, event.clientY - lastCanvasClick.y) < 16;
  const star = recent ? lastCanvasClick.star : hitTest(event.clientX - rect.left, event.clientY - rect.top);
  if (star) beginFlight(star);
});
canvas.addEventListener('pointercancel', () => { pointer = null; canvas.classList.remove('dragging'); });
canvas.addEventListener('pointerleave', () => { $('tooltip').hidden = true; state.hover = null; dirty = true; });
function zoom(amount) {
  if (state.view === 'external') {
    state.orbit.distance = clamp(state.orbit.distance * Math.exp(amount * .025), state.orbit.extent * .15, state.orbit.extent * 12);
  } else {
    state.fov = clamp(state.fov + amount, 25, 120);
  }
  updateZoomLabel();
  dirty = true;
}
canvas.addEventListener('wheel', event => { event.preventDefault(); zoom(Math.sign(event.deltaY) * 3); }, { passive: false });
canvas.addEventListener('keydown', event => {
  if ((state.flight && state.view === 'sky') || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '='].includes(event.key)) return;
  event.preventDefault();
  state.focus = null;
  const camera = state.view === 'external' ? state.orbit : state;
  const pitchLimit = state.view === 'external' ? 1.5 : 1.569;
  if (event.key === 'ArrowLeft') camera.yaw += .07;
  if (event.key === 'ArrowRight') camera.yaw -= .07;
  if (event.key === 'ArrowUp') camera.pitch = clamp(camera.pitch + .07, -pitchLimit, pitchLimit);
  if (event.key === 'ArrowDown') camera.pitch = clamp(camera.pitch - .07, -pitchLimit, pitchLimit);
  if (event.key === '+' || event.key === '=') zoom(-5);
  if (event.key === '-') zoom(5);
  dirty = true;
});
$('zoom-in').addEventListener('click', () => zoom(-8));
$('zoom-out').addEventListener('click', () => zoom(8));
$('reset-button').addEventListener('click', () => {
  if (state.view === 'external') resetOrbit(); else focusStar(state.location === sol ? alpha : sol);
});
$('neighborhood-button').addEventListener('click', () => setView(state.view === 'sky' ? 'external' : 'sky'));
$('sky-view-button').addEventListener('click', () => setView('sky'));
$('fly-button').addEventListener('click', () => {
  if (state.flight) {
    state.flight.paused = !state.flight.paused;
    $('fly-button').textContent = state.flight.paused ? 'Resume flight \u2192' : 'Pause flight \u2161';
    $('flight-status').textContent = state.flight.paused ? 'Flight paused' : 'Flight resumed';
  } else {
    beginFlight(state.location === sol ? alpha : sol);
  }
});
$('skip-button').addEventListener('click', finishFlight);
$('selection-action').addEventListener('click', () => {
  beginFlight(state.selected);
});
for (const setting of ['grid', 'labels', 'directions']) {
  $(`${setting}-toggle`).addEventListener('click', () => {
    state[setting] = !state[setting];
    $(`${setting}-toggle`).setAttribute('aria-pressed', String(state[setting]));
    if (setting === 'directions') updateDirectionButtons();
    dirty = true;
  });
}
for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => {
    state.tab = button.dataset.tab;
    for (const tab of document.querySelectorAll('[data-tab]')) tab.setAttribute('aria-selected', String(tab === button));
    renderList();
  });
}
$('search').addEventListener('input', renderList);
$('theme-button').addEventListener('click', () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  readPalette();
});
$('catalog-toggle').addEventListener('click', () => {
  const open = $('catalog-panel').classList.toggle('open');
  $('catalog-toggle').setAttribute('aria-expanded', String(open));
});
$('catalog-close').addEventListener('click', () => {
  $('catalog-panel').classList.remove('open');
  $('catalog-toggle').setAttribute('aria-expanded', 'false');
  $('catalog-toggle').focus();
});
for (const id of ['about-button', 'data-note-button']) $(id).addEventListener('click', () => $('about-dialog').showModal());
$('highlights-button').addEventListener('click', () => {
  $('highlight-names').value = state.rawHighlights;
  $('highlight-feedback').textContent = '';
  $('highlights-dialog').showModal();
});
$('save-highlights').addEventListener('click', () => {
  const entries = $('highlight-names').value.split(/[\n,;]+/).map(name => name.trim()).filter(Boolean);
  const ids = new Set(), unknown = [];
  for (const entry of entries) {
    const query = normalize(entry);
    const star = stars.find(item => [item.id, item.name, item.catalogName, ...(item === sol ? ['Earth', 'Sol', 'Sun'] : [])].some(name => normalize(name) === query));
    if (star) ids.add(star.id); else unknown.push(entry);
  }
  state.marks = ids;
  state.rawHighlights = $('highlight-names').value;
  const saved = persistMarks();
  $('highlight-feedback').textContent = `${ids.size} system${ids.size === 1 ? '' : 's'} highlighted.${unknown.length ? ` Not in this catalog: ${unknown.join(', ')}.` : ''}${saved ? '' : ' Browser storage unavailable; highlights apply for this visit only.'}`;
  renderList();
  updateSelection();
  dirty = true;
});
$('mark-star').addEventListener('click', () => {
  const id = state.selected.id;
  if (state.marks.has(id)) state.marks.delete(id); else state.marks.add(id);
  state.rawHighlights = stars.filter(star => state.marks.has(star.id)).map(displayName).join('\n');
  const saved = persistMarks();
  $('announcement').textContent = saved ? 'Highlights updated.' : 'Highlights updated for this visit. Browser storage unavailable.';
  updateSelection();
  renderList();
  dirty = true;
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    if (window.innerWidth <= 850) {
      $('catalog-panel').classList.add('open');
      $('catalog-toggle').setAttribute('aria-expanded', 'true');
    }
    $('search').focus();
  }
  if (event.key === 'Escape') {
    $('catalog-panel').classList.remove('open');
    $('catalog-toggle').setAttribute('aria-expanded', 'false');
    if (state.view === 'external' && !document.querySelector('dialog[open]')) setView('sky');
  }
});
const resizeObserver = new ResizeObserver(resize);
for (const element of [$('map'), document.querySelector('.selection-card'), document.querySelector('.flight-dock')]) resizeObserver.observe(element);
readPalette();
renderList();
updateLocationUI();
resize();
requestAnimationFrame(animate);
