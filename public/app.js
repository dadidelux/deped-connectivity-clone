// DepEd Schools Connectivity — clean-room clone, static data source.
//
// Bug fixes vs the origin dashboard (see PLANS/DEPED_CLONE_VERCEL_DEPLOY.md):
//  1. Starlink (9,909 schools, 20.7%) is its own counter, not folded into "Others".
//  2. Blank type_of_connection rows (6,565) get an explicit "Not specified"
//     counter so the visible breakdown always sums to the visible school count
//     (online + offline), instead of silently dropping ~14% of rows.
//  3. No "Limited" legend row: the live `connectivity` column only ever holds
//     0/1, so a third tier would be a legend entry backed by zero data.
//
// Counter rows are generated from the data itself (grouped by whatever
// `type_of_connection` values are actually present), not from a hardcoded
// list of <div>s — a new connection type becomes a new row automatically.

const CONFIG = {
  DATA_SOURCE: "static", // 'static' | 'api' — swap later without touching the UI
  REGION: "Region IV-A",
  MAP: {
    CENTER: [14.0, 121.5],
    ZOOM: 9,
    BOUNDS: [
      [13.0, 120.0],
      [15.0, 123.0],
    ],
  },
  CONNECTION_TYPE_LABELS: {
    "": "Not specified",
    fiber: "Fiber",
    starlink: "Starlink",
    cable: "Cable",
    dsl: "DSL",
    "mobile data": "Mobile Data",
    satellite: "Satellite",
    "wireless broadband": "Wireless Broadband",
    "point-to-point": "Point-to-Point",
    others: "Others",
  },
};

const state = {
  columns: [],
  schools: [], // [{ id, name, lat, lng, region, province, ..., connectivity, connectionType }] — all 18 regions
  connectionTypes: [], // sorted by count desc: [{ key, label, count }]
  filters: {
    status: "all",
    connectionTypes: new Set(),
    province: "all",
    district: "all",
    municipality: "all",
    project: "all",
  },
  markers: null,
  map: null,
};

const els = {};

function cacheEls() {
  [
    "app", "loading-overlay", "error-state", "error-message", "retry-load",
    "connection-type-list", "map-legend", "connection-breakdown",
    "stat-visible", "stat-online", "stat-offline", "connected-pct",
    "connected-donut", "clock", "reset-filters", "school-modal", "modal-title",
    "modal-body", "modal-close",
    "filter-province", "filter-district", "filter-municipality", "filter-project",
    "filter-status-select",
  ].forEach((id) => { els[id] = document.getElementById(id); });
  els.layout = document.querySelector(".layout");
}

async function loadData() {
  if (CONFIG.DATA_SOURCE !== "static") {
    throw new Error("API data source not wired up in this build");
  }
  const manifestRes = await fetch("/data/manifest.json");
  if (!manifestRes.ok) throw new Error(`manifest.json HTTP ${manifestRes.status}`);
  const manifest = await manifestRes.json();

  const dataRes = await fetch(`/data/${manifest.file}`);
  if (!dataRes.ok) throw new Error(`${manifest.file} HTTP ${dataRes.status}`);
  const payload = await dataRes.json();

  return { manifest, columns: payload.columns, rows: payload.rows };
}

function normalizeConnectivity(rawValue) {
  // Live data only ever holds "0" or "1" — no third state to model.
  return rawValue === "1" ? "online" : "offline";
}

function rehydrate(columns, rows) {
  const idx = Object.fromEntries(columns.map((c, i) => [c, i]));
  return rows.map((row) => ({
    id: row[idx.id],
    name: row[idx.school_name],
    lat: Number.parseFloat(row[idx.latitude]),
    lng: Number.parseFloat(row[idx.longitude]),
    region: row[idx.region],
    province: row[idx.province],
    district: row[idx.legislative_district],
    municipality: row[idx.municipality],
    barangay: row[idx.barangay],
    connectivity: normalizeConnectivity(row[idx.connectivity]),
    project: row[idx.project_allocation],
    connectionType: (row[idx.type_of_connection] || "").toLowerCase(),
  }));
}

function hasValidCoords(school) {
  return (
    Number.isFinite(school.lat) &&
    Number.isFinite(school.lng) &&
    school.lat !== 0 &&
    school.lng !== 0
  );
}

function buildConnectionTypeIndex(schools) {
  const counts = new Map();
  for (const s of schools) {
    counts.set(s.connectionType, (counts.get(s.connectionType) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      label: CONFIG.CONNECTION_TYPE_LABELS[key] ?? key,
      count,
    }))
    .sort((a, b) => b.count - a.count);
}

function renderConnectionTypeFilter(types) {
  els["connection-type-list"].innerHTML = "";
  for (const t of types) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = t.key;
    checkbox.checked = state.filters.connectionTypes.has(t.key);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.filters.connectionTypes.add(t.key);
      else state.filters.connectionTypes.delete(t.key);
      applyFilters();
    });
    label.append(checkbox, document.createTextNode(` ${t.label} (${t.count.toLocaleString()})`));
    els["connection-type-list"].append(label);
  }
}

const LOCATION_FILTER_FIELDS = [
  { field: "province", elId: "filter-province" },
  { field: "district", elId: "filter-district" },
  { field: "municipality", elId: "filter-municipality" },
  { field: "project", elId: "filter-project" },
];

function renderLocationFilters(schools) {
  for (const { field, elId } of LOCATION_FILTER_FIELDS) {
    const select = els[elId];
    const current = state.filters[field];
    const values = [...new Set(schools.map((s) => s[field]).filter(Boolean))].sort();
    select.innerHTML = "";
    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = "All";
    select.append(allOption);
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    select.value = values.includes(current) ? current : "all";
  }
}

function initFilterDefaults() {
  state.filters.connectionTypes = new Set(state.connectionTypes.map((t) => t.key));
  for (const { field } of LOCATION_FILTER_FIELDS) {
    state.filters[field] = "all";
  }
}

function getFilteredSchools() {
  return state.schools.filter((s) => {
    if (state.filters.status !== "all" && s.connectivity !== state.filters.status) return false;
    if (!state.filters.connectionTypes.has(s.connectionType)) return false;
    for (const { field } of LOCATION_FILTER_FIELDS) {
      if (state.filters[field] !== "all" && s[field] !== state.filters[field]) return false;
    }
    return true;
  });
}

function drawDonut(pct) {
  const canvas = els["connected-donut"];
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2, r = w / 2 - 8;
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 12;

  ctx.strokeStyle = "#e2e8f0";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "#16a34a";
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (pct / 100));
  ctx.stroke();
}

function renderStats(filtered) {
  const online = filtered.filter((s) => s.connectivity === "online").length;
  const offline = filtered.length - online;
  const pct = filtered.length ? (online / filtered.length) * 100 : 0;

  els["stat-visible"].textContent = filtered.length.toLocaleString();
  els["stat-online"].textContent = online.toLocaleString();
  els["stat-offline"].textContent = offline.toLocaleString();
  els["connected-pct"].textContent = `${pct.toFixed(2)}%`;
  drawDonut(pct);

  const breakdown = buildConnectionTypeIndex(filtered);
  els["connection-breakdown"].innerHTML = "";
  for (const t of breakdown) {
    const li = document.createElement("li");
    const labelSpan = document.createElement("span");
    labelSpan.textContent = t.label;
    const countSpan = document.createElement("span");
    countSpan.textContent = t.count.toLocaleString();
    li.append(labelSpan, countSpan);
    els["connection-breakdown"].append(li);
  }
}

function markerColor(school) {
  return school.connectivity === "online" ? "#16a34a" : "#dc2626";
}

function buildMarker(school) {
  const marker = L.circleMarker([school.lat, school.lng], {
    radius: 6,
    color: markerColor(school),
    fillColor: markerColor(school),
    fillOpacity: 0.85,
    weight: 1,
  });
  marker.on("click", () => openModal(school));
  const tooltipEl = document.createElement("span");
  tooltipEl.textContent = school.name;
  marker.bindTooltip(tooltipEl, { direction: "top" });
  return marker;
}

function renderMap(filtered) {
  state.markers.clearLayers();
  const withCoords = filtered.filter(hasValidCoords);
  for (const school of withCoords) {
    state.markers.addLayer(buildMarker(school));
  }
}

function applyFilters() {
  const filtered = getFilteredSchools();
  renderStats(filtered);
  renderMap(filtered);
}

function openModal(school) {
  els["modal-title"].textContent = school.name;
  els["modal-body"].innerHTML = "";
  const rows = [
    ["Region", school.region],
    ["Province", school.province],
    ["Municipality", school.municipality],
    ["Barangay", school.barangay],
    ["District", school.district],
    ["Status", school.connectivity === "online" ? "Online" : "Offline"],
    ["Connection type", CONFIG.CONNECTION_TYPE_LABELS[school.connectionType] ?? "Not specified"],
    ["Project", school.project],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value || "—";
    els["modal-body"].append(dt, dd);
  }
  els["school-modal"].hidden = false;
  els["modal-close"].focus();
}

function closeModal() {
  els["school-modal"].hidden = true;
}

function initMap() {
  state.map = L.map("map", {
    maxBounds: CONFIG.MAP.BOUNDS,
    maxBoundsViscosity: 1.0,
  }).setView(CONFIG.MAP.CENTER, CONFIG.MAP.ZOOM);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(state.map);

  state.markers = L.markerClusterGroup({ chunkedLoading: true });
  state.map.addLayer(state.markers);
}

function startClock() {
  const tick = () => {
    els.clock.textContent = new Date().toLocaleString("en-PH", {
      dateStyle: "medium",
      timeStyle: "medium",
    });
  };
  tick();
  setInterval(tick, 1000);
}

function showLoading() {
  els["loading-overlay"].hidden = false;
  els["error-state"].hidden = true;
  if (els.layout) els.layout.hidden = true;
}
function showError(message) {
  els["loading-overlay"].hidden = true;
  els["error-state"].hidden = false;
  els["error-message"].textContent = message;
  if (els.layout) els.layout.hidden = true;
}
function showLoaded() {
  els["loading-overlay"].hidden = true;
  els["error-state"].hidden = true;
  if (els.layout) els.layout.hidden = false;
  // Leaflet inits while .layout is still hidden (display:none), caching a
  // 0x0 container size. At 0x0, maxBoundsViscosity clamps the initial view to
  // a corner of maxBounds; invalidateSize() alone preserves that bad center
  // instead of restoring it, so recenter explicitly once visible.
  if (state.map) {
    state.map.invalidateSize();
    state.map.setView(CONFIG.MAP.CENTER, CONFIG.MAP.ZOOM);
  }
}

async function boot() {
  cacheEls();
  showLoading();
  startClock();

  els["retry-load"].addEventListener("click", boot);
  els["modal-close"].addEventListener("click", closeModal);
  els["school-modal"].addEventListener("click", (e) => {
    if (e.target === els["school-modal"]) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els["school-modal"].hidden) closeModal();
  });
  els["reset-filters"].addEventListener("click", () => {
    initFilterDefaults();
    renderConnectionTypeFilter(state.connectionTypes);
    renderLocationFilters(state.schools);
    els["filter-status-select"].value = "all";
    state.filters.status = "all";
    applyFilters();
  });
  els["filter-status-select"].addEventListener("change", (e) => {
    state.filters.status = e.target.value;
    applyFilters();
  });
  for (const { field, elId } of LOCATION_FILTER_FIELDS) {
    els[elId].addEventListener("change", (e) => {
      state.filters[field] = e.target.value;
      applyFilters();
    });
  }

  try {
    const { columns, rows } = await loadData();
    state.columns = columns;
    state.schools = rehydrate(columns, rows).filter((s) => s.region === CONFIG.REGION);
    state.connectionTypes = buildConnectionTypeIndex(state.schools);

    initFilterDefaults();
    initMap();
    renderConnectionTypeFilter(state.connectionTypes);
    renderLocationFilters(state.schools);
    applyFilters();
    showLoaded();
  } catch (err) {
    console.error(err);
    showError(`Could not load school data: ${err.message}`);
  }
}

boot();
