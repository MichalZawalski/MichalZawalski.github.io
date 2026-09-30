/* ===== CoDeC (Contamination Detection via Context) Leaderboard — Frontend Logic ===== */

let rawData = null;
let dataMap = {};
let sortCol = "__avg";
let sortAsc = false;
let sortRow = null;           // model key for sorting columns
let sortRowAsc = true;
let activeModelDetail = null;
let chartInstances = [];
let activePreset = { model: null, benchmark: null };  // currently applied preset per panel
let firstLoad = true;  // true until fetchData has run once; drives default-preset application

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------

// YlOrRd colormap (9-stop, from matplotlib/ColorBrewer)
const YLORRD = [
  [255, 255, 204],  // 0.0  pale yellow
  [255, 237, 160],  // 0.125
  [254, 217, 118],  // 0.25
  [254, 178, 76],   // 0.375
  [253, 141, 60],   // 0.5
  [252, 78, 42],    // 0.625
  [227, 26, 28],    // 0.75
  [189, 0, 38],     // 0.875
  [128, 0, 38],     // 1.0  dark red
];

function interpolatePalette(palette, t) {
  t = Math.max(0, Math.min(1, t));
  const idx = t * (palette.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, palette.length - 1);
  const f = idx - lo;
  return [
    Math.round(palette[lo][0] + (palette[hi][0] - palette[lo][0]) * f),
    Math.round(palette[lo][1] + (palette[hi][1] - palette[lo][1]) * f),
    Math.round(palette[lo][2] + (palette[hi][2] - palette[lo][2]) * f),
  ];
}

function ylOrRdColor(t) {
  const [r, g, b] = interpolatePalette(YLORRD, t);
  return `rgb(${r},${g},${b})`;
}

function heatmapColor(score) {
  // Map 0.0–1.0 score to colormap, clamping below 0.2 to the lightest color
  const t = Math.max(0, Math.min(1, (score - 0.2) / 0.8));
  return ylOrRdColor(t);
}

function textColorForBg(score) {
  // YlOrRd is light at low values, dark at high — switch at ~0.6
  return score > 0.6 ? "#fff" : "#333";
}

// Publication-date shading: a single cool hue (slate blue) kept very light so
// it never competes with the warm YlOrRd contamination colors. Newest models
// get the strongest tint; anything older than RECENCY_HORIZON_DAYS is ~white.
const RECENCY_HORIZON_DAYS = 600;  // 20 months

function ageInDays(dateStr) {
  return (Date.now() - new Date(dateStr + "T00:00:00Z").getTime()) / 86400000;
}

function recencyColor(dateStr) {
  const t = Math.max(0, Math.min(1, 1 - ageInDays(dateStr) / RECENCY_HORIZON_DAYS));
  const lightness = 98 - 12 * t;          // 98% (old) -> 86% (newest)
  const saturation = 25 + 70 * t;         // 25% -> 95%
  return `hsl(212, ${saturation}%, ${lightness}%)`;
}

function ageLabel(dateStr) {
  const months = Math.round(ageInDays(dateStr) / 30.44);
  if (months <= 0) return "this month";
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = (months / 12).toFixed(1).replace(/\.0$/, "");
  return `${years} year${years === "1" ? "" : "s"} ago`;
}

// ---------------------------------------------------------------------------
// Chart.js global defaults for light theme
// ---------------------------------------------------------------------------
function setChartDefaults() {
  Chart.defaults.color = "#555";
  Chart.defaults.borderColor = "#e5e5e5";
  Chart.defaults.plugins.tooltip.backgroundColor = "#fff";
  Chart.defaults.plugins.tooltip.titleColor = "#222";
  Chart.defaults.plugins.tooltip.bodyColor = "#444";
  Chart.defaults.plugins.tooltip.borderColor = "#ddd";
  Chart.defaults.plugins.tooltip.borderWidth = 1;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchData() {
  try {
    const resp = await fetch("./data.json");
    rawData = await resp.json();
  } catch (e) {
    console.error("Failed to fetch data:", e);
    return;
  }

  dataMap = {};
  for (const row of rawData.rows) {
    if (!dataMap[row.model]) dataMap[row.model] = {};
    dataMap[row.model][row.benchmark] = { score: row.score, run_url: row.run_url };
  }

  const el = document.getElementById("last-updated");
  if (rawData.last_updated) {
    const d = new Date(rawData.last_updated);
    el.textContent = "Updated " + d.toLocaleString();
  } else {
    el.textContent = "No data yet";
  }

  const prevModels = getSelected("model-select");
  const prevBench = getSelected("benchmark-select");
  populateSelect("model-select", rawData.models, prevModels);
  populateSelect("benchmark-select", rawData.benchmarks, prevBench,
                  rawData.benchmark_display_names);
  renderPresetChips("model");
  renderPresetChips("benchmark");
  // On the very first fetch, take the selection from the URL if it specifies
  // one, otherwise fall back to a preset literally named "default". Both
  // override the "all selected" state populateSelect starts from.
  if (firstLoad) {
    if (!applyUrlState("model")) applyDefaultPreset("model");
    if (!applyUrlState("benchmark")) applyDefaultPreset("benchmark");
    firstLoad = false;
  }
  // Filter panels in case the search box already has text (e.g. after refresh).
  filterPanel("model");
  filterPanel("benchmark");
  // Re-detect active preset (selection may match a preset after re-fetch).
  activePreset.model = detectActivePreset("model");
  activePreset.benchmark = detectActivePreset("benchmark");
  updatePresetHighlight("model");
  updatePresetHighlight("benchmark");
  updateSelectionCount("model");
  updateSelectionCount("benchmark");
  syncUrl();
  render();
}

function applyDefaultPreset(panelName) {
  const preset = presetsFor(panelName).find(
    p => !p.variants && p.name.toLowerCase() === "default"
  );
  if (!preset) return false;
  applyPreset(panelName, presetMembers(panelName, preset), preset.name);
  return true;
}

// ---------------------------------------------------------------------------
// URL view state
// ---------------------------------------------------------------------------
// The selection is mirrored into the query string so a view can be linked.
// Hybrid encoding: when everything is selected we emit ?models=all; when the
// selection matches a named set, the short form (?bset=default); otherwise the
// explicit members (?benchmarks=hle,lcr).
// The URL is rewritten with replaceState on every change, so the address bar
// is always shareable without filling up the back-button history.

const URL_ALL = "all";  // ?models=all / ?benchmarks=all selects everything

const URL_KEYS = {
  model: { set: "mset", list: "models" },
  benchmark: { set: "bset", list: "benchmarks" },
};

// Apply whatever the URL asks for. Returns true if it selected something, so
// the caller knows whether to fall back to the "default" preset.
function applyUrlState(panelName) {
  if (!rawData) return false;
  const params = new URLSearchParams(location.search);
  const keys = URL_KEYS[panelName];

  const presetId = params.get(keys.set);
  if (presetId) {
    const preset = findPreset(panelName, presetId);
    if (preset) {
      applyPreset(panelName, presetMembers(panelName, preset), presetId);
      return true;
    }
    console.warn(`Unknown ${panelName} set in URL: "${presetId}" — ignoring.`);
  }

  const list = params.get(keys.list);
  if (list !== null && list.trim().toLowerCase() === URL_ALL) {
    applyPreset(panelName, availableItems(panelName), null);
    notifySelectionChanged(panelName);
    return true;
  }
  if (list !== null) {
    const available = new Set(availableItems(panelName));
    const wanted = list.split(",").map(s => s.trim()).filter(Boolean);
    const valid = wanted.filter(item => available.has(item));
    const unknown = wanted.filter(item => !available.has(item));
    if (unknown.length) {
      console.warn(`Unknown ${panelName}(s) in URL: ${unknown.join(", ")} — ignoring.`);
    }
    // An empty list is a deliberate "select nothing", so honour it too.
    if (valid.length || list === "") {
      applyPreset(panelName, valid, null);
      notifySelectionChanged(panelName);
      return true;
    }
  }
  return false;
}

function syncUrl() {
  if (!rawData || firstLoad) return;
  const params = new URLSearchParams(location.search);
  for (const panelName of ["model", "benchmark"]) {
    const keys = URL_KEYS[panelName];
    params.delete(keys.set);
    params.delete(keys.list);
    const selected = getSelected(`${panelName}-select`);
    const total = availableItems(panelName).length;
    if (total > 0 && selected.length === total) {
      params.set(keys.list, URL_ALL);
    } else if (activePreset[panelName]) {
      params.set(keys.set, activePreset[panelName]);
    } else {
      params.set(keys.list, selected.join(","));
    }
  }
  history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`);
}

// ---------------------------------------------------------------------------
// Checkbox panel helpers
// ---------------------------------------------------------------------------

function populateSelect(id, items, previousSelection, displayNames) {
  const panel = document.getElementById(id);
  panel.innerHTML = "";
  const panelName = id.replace("-select", "");  // "model" or "benchmark"

  // Compute the grouping and the per-item display-name function.
  let groups;
  let itemDisplayName;
  if (id === "model-select") {
    groups = groupModelsByVendor(items);
    itemDisplayName = (m) => m.substring(m.indexOf("/") + 1);
  } else {
    groups = groupBenchmarksByCategory(items, rawData.benchmark_categories || {});
    itemDisplayName = (b) => (displayNames && displayNames[b]) || b;
  }

  for (const [groupName, groupItems] of Object.entries(groups)) {
    if (groupItems.length === 0) continue;

    const group = document.createElement("div");
    group.className = "family-group";

    // Categories are folded by default. Users expand what they need; search
    // and applyPreset auto-expand groups that match / contain checked items.
    const header = document.createElement("div");
    header.className = "family-header collapsed";

    const familyCb = document.createElement("input");
    familyCb.type = "checkbox";
    familyCb.className = "family-cb";

    const chevron = document.createElement("span");
    chevron.className = "family-chevron";
    chevron.textContent = "\u25BC";

    const label = document.createElement("span");
    label.className = "family-label";
    label.textContent = groupName;

    header.appendChild(familyCb);
    header.appendChild(label);
    header.appendChild(chevron);

    const body = document.createElement("div");
    body.className = "family-body collapsed";

    chevron.addEventListener("click", (e) => {
      e.stopPropagation();
      header.classList.toggle("collapsed");
      body.classList.toggle("collapsed");
    });
    header.addEventListener("click", (e) => {
      if (e.target === familyCb) return;
      header.classList.toggle("collapsed");
      body.classList.toggle("collapsed");
    });

    for (const item of groupItems) {
      const lbl = document.createElement("label");
      lbl.className = "filter-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = item;
      cb.checked = previousSelection.length === 0 || previousSelection.includes(item);
      cb.addEventListener("change", () => {
        updateFamilyCheckbox(familyCb, body);
        notifySelectionChanged(panelName);
        render();
      });
      const span = document.createElement("span");
      span.textContent = itemDisplayName(item);
      lbl.appendChild(cb);
      lbl.appendChild(span);
      body.appendChild(lbl);
    }

    familyCb.addEventListener("change", () => {
      const checked = familyCb.checked;
      body.querySelectorAll("input[type=\"checkbox\"]").forEach(cb => { cb.checked = checked; });
      familyCb.indeterminate = false;
      notifySelectionChanged(panelName);
      render();
    });

    group.appendChild(header);
    group.appendChild(body);
    panel.appendChild(group);

    updateFamilyCheckbox(familyCb, body);
  }
}

function groupModelsByVendor(items) {
  const groups = {};
  for (const item of items) {
    const slash = item.indexOf("/");
    const vendor = slash > 0 ? item.substring(0, slash) : "Checkpoints";
    if (!groups[vendor]) groups[vendor] = [];
    groups[vendor].push(item);
  }
  // Alphabetical vendor order.
  return Object.fromEntries(Object.entries(groups).sort());
}

function groupBenchmarksByCategory(items, categories) {
  const itemSet = new Set(items);
  const assigned = new Set();
  const groups = {};
  // Preserve the order defined in config.yaml.
  for (const [category, benches] of Object.entries(categories)) {
    const inCat = benches.filter(b => itemSet.has(b));
    if (inCat.length > 0) {
      groups[category] = inCat;
      inCat.forEach(b => assigned.add(b));
    }
  }
  const other = items.filter(b => !assigned.has(b));
  if (other.length > 0) groups["Other"] = other;
  return groups;
}

function updateFamilyCheckbox(familyCb, body) {
  const cbs = body.querySelectorAll("input[type=\"checkbox\"]");
  const total = cbs.length;
  let checked = 0;
  cbs.forEach(cb => { if (cb.checked) checked++; });
  familyCb.checked = checked === total;
  familyCb.indeterminate = checked > 0 && checked < total;
}

function getSelected(id) {
  return Array.from(document.querySelectorAll(`#${id} input[type="checkbox"]:not(.family-cb):checked`)).map(cb => cb.value);
}

function selectAll(id) {
  document.querySelectorAll(`#${id} input[type="checkbox"]`).forEach(cb => { cb.checked = true; cb.indeterminate = false; });
  notifySelectionChanged(id.replace("-select", ""));
  render();
}

function selectNone(id) {
  document.querySelectorAll(`#${id} input[type="checkbox"]`).forEach(cb => { cb.checked = false; cb.indeterminate = false; });
  notifySelectionChanged(id.replace("-select", ""));
  render();
}

// ---------------------------------------------------------------------------
// Preset chips, search, and selection count
// ---------------------------------------------------------------------------
// Presets come from rawData.benchmark_sets / rawData.model_sets. Each entry
// is either a simple set ({name, benchmarks|models}) or a versioned set
// ({name, variants: [{label, benchmarks|models}, ...]}). Clicking a chip
// replaces the current selection with that set's members.

function panelItemsKey(panelName) {
  return panelName === "model" ? "models" : "benchmarks";
}

function presetsFor(panelName) {
  if (!rawData) return [];
  return (panelName === "model" ? rawData.model_sets : rawData.benchmark_sets) || [];
}

function availableItems(panelName) {
  if (!rawData) return [];
  return (panelName === "model" ? rawData.models : rawData.benchmarks) || [];
}

// Resolve a preset (or a variant) to the items it actually selects. A set with
// `all: true` expands to everything currently in the data; otherwise members
// are intersected with what's available, so a set may safely name a benchmark
// that has no results yet without breaking chip highlighting.
function presetMembers(panelName, source) {
  const available = availableItems(panelName);
  if (source && source.all) return available.slice();
  const wanted = new Set((source && source[panelItemsKey(panelName)]) || []);
  return available.filter(item => wanted.has(item));
}

// Find a preset or variant by the id used in chips and URLs ("Name" or
// "Name:Variant"). Returns the object holding the members, or null.
function findPreset(panelName, presetId) {
  for (const preset of presetsFor(panelName)) {
    if (preset.variants) {
      for (const variant of preset.variants) {
        if (`${preset.name}:${variant.label}` === presetId) return variant;
      }
    } else if (preset.name === presetId) {
      return preset;
    }
  }
  return null;
}

function renderPresetChips(panelName) {
  const container = document.getElementById(`${panelName}-presets`);
  if (!container) return;
  container.innerHTML = "";
  const key = panelItemsKey(panelName);

  for (const preset of presetsFor(panelName)) {
    if (preset.variants) {
      const group = document.createElement("span");
      group.className = "preset-group";
      const label = document.createElement("span");
      label.className = "preset-group-label";
      label.textContent = preset.name;
      group.appendChild(label);
      for (const variant of preset.variants) {
        const presetId = `${preset.name}:${variant.label}`;
        const chip = makePresetChip(panelName, variant.label, variant, presetId);
        chip.classList.add("preset-variant");
        group.appendChild(chip);
      }
      container.appendChild(group);
    } else {
      const chip = makePresetChip(panelName, preset.name, preset, preset.name);
      container.appendChild(chip);
    }
  }
  updatePresetHighlight(panelName);
}

function makePresetChip(panelName, label, source, presetId) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "preset-chip";
  chip.textContent = label;
  chip.dataset.presetId = presetId;
  // Members are resolved on click, so an `all: true` set tracks the live data.
  chip.addEventListener("click", () =>
    applyPreset(panelName, presetMembers(panelName, source), presetId));
  return chip;
}

function applyPreset(panelName, items, presetId) {
  const panelId = `${panelName}-select`;
  const wanted = new Set(items);
  document.querySelectorAll(`#${panelId} input[type="checkbox"]:not(.family-cb)`).forEach(cb => {
    cb.checked = wanted.has(cb.value);
  });
  document.querySelectorAll(`#${panelId} .family-group`).forEach(g => {
    const familyCb = g.querySelector(".family-cb");
    const body = g.querySelector(".family-body");
    if (familyCb && body) updateFamilyCheckbox(familyCb, body);
  });
  activePreset[panelName] = presetId;
  updatePresetHighlight(panelName);
  updateSelectionCount(panelName);
  syncUrl();
  render();
}

function detectActivePreset(panelName) {
  if (!rawData) return null;
  const selected = new Set(getSelected(`${panelName}-select`));
  if (selected.size === 0) return null;
  for (const preset of presetsFor(panelName)) {
    if (preset.variants) {
      for (const v of preset.variants) {
        if (setsEqual(selected, new Set(presetMembers(panelName, v)))) {
          return `${preset.name}:${v.label}`;
        }
      }
    } else {
      if (setsEqual(selected, new Set(presetMembers(panelName, preset)))) return preset.name;
    }
  }
  return null;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function updatePresetHighlight(panelName) {
  const active = activePreset[panelName];
  document.querySelectorAll(`#${panelName}-presets .preset-chip`).forEach(chip => {
    chip.classList.toggle("active", chip.dataset.presetId === active);
  });
}

function updateSelectionCount(panelName) {
  const el = document.getElementById(`${panelName}-count`);
  if (!el) return;
  const panelId = `${panelName}-select`;
  const total = document.querySelectorAll(`#${panelId} input[type="checkbox"]:not(.family-cb)`).length;
  const checked = document.querySelectorAll(`#${panelId} input[type="checkbox"]:not(.family-cb):checked`).length;
  el.textContent = `${checked} / ${total}`;
}

function notifySelectionChanged(panelName) {
  activePreset[panelName] = detectActivePreset(panelName);
  updatePresetHighlight(panelName);
  updateSelectionCount(panelName);
  syncUrl();
}

function filterPanel(panelName) {
  const search = document.getElementById(`${panelName}-search`);
  const panel = document.getElementById(`${panelName}-select`);
  if (!search || !panel) return;
  const query = search.value.trim().toLowerCase();

  panel.querySelectorAll(".filter-item").forEach(item => {
    const label = item.querySelector("span:last-child")?.textContent.toLowerCase() || "";
    const raw = item.querySelector("input[type=\"checkbox\"]")?.value.toLowerCase() || "";
    const matches = !query || label.includes(query) || raw.includes(query);
    item.classList.toggle("hidden-by-filter", !matches);
  });

  panel.querySelectorAll(".family-group").forEach(group => {
    const visible = group.querySelectorAll(".filter-item:not(.hidden-by-filter)");
    group.classList.toggle("hidden-by-filter", visible.length === 0);
    // Force-expand groups that contain a match while searching.
    if (query && visible.length > 0) {
      group.querySelector(".family-body")?.classList.remove("collapsed");
      group.querySelector(".family-header")?.classList.remove("collapsed");
    }
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const models = getSelected("model-select");
  const benchmarks = getSelected("benchmark-select");
  renderTable(models, benchmarks);
  renderCharts(models, benchmarks);
  if (activeModelDetail && models.includes(activeModelDetail)) {
    showModelDetail(activeModelDetail, false);
  } else {
    closeModelDetail();
  }
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function renderTable(models, benchmarks) {
  if (!rawData) return;
  const container = document.getElementById("table-container");
  const dn = rawData.benchmark_display_names || {};

  // Compute average score per model (over selected benchmarks)
  function avgScore(model) {
    let sum = 0, count = 0;
    for (const b of benchmarks) {
      const s = dataMap[model]?.[b]?.score;
      if (s != null) { sum += s; count++; }
    }
    return count > 0 ? sum / count : null;
  }

  const dates = rawData.model_dates || {};

  let sortedModels = [...models];
  if (sortCol === "__model") {
    sortedModels.sort((a, b) => sortAsc ? a.localeCompare(b) : b.localeCompare(a));
  } else if (sortCol === "__avg") {
    sortedModels.sort((a, b) => {
      const sa = avgScore(a) ?? -1;
      const sb = avgScore(b) ?? -1;
      return sortAsc ? sa - sb : sb - sa;
    });
  } else if (sortCol === "__date") {
    sortedModels.sort((a, b) => {
      const da = dates[a];
      const db = dates[b];
      // Missing dates sort to end regardless of direction.
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return sortAsc ? da.localeCompare(db) : db.localeCompare(da);
    });
  } else if (sortCol && benchmarks.includes(sortCol)) {
    sortedModels.sort((a, b) => {
      const sa = dataMap[a]?.[sortCol]?.score ?? -1;
      const sb = dataMap[b]?.[sortCol]?.score ?? -1;
      return sortAsc ? sa - sb : sb - sa;
    });
  }

  // Sort benchmarks (columns) by a model's scores
  let sortedBenchmarks = [...benchmarks];
  if (sortRow && models.includes(sortRow)) {
    sortedBenchmarks.sort((a, b) => {
      const sa = dataMap[sortRow]?.[a]?.score ?? -1;
      const sb = dataMap[sortRow]?.[b]?.score ?? -1;
      return sortRowAsc ? sa - sb : sb - sa;
    });
  }

  let html = "<table><thead><tr>";
  html += `<th class="model-header">` +
          `Model` +
          `<span class="header-sort">` +
          `<span class="sort-arrow sort-up ${sortCol === '__model' && sortAsc ? 'active' : ''}" onclick="sortBy('__model',true)" title="Sort A→Z">&#9650;</span>` +
          `<span class="sort-arrow sort-down ${sortCol === '__model' && !sortAsc ? 'active' : ''}" onclick="sortBy('__model',false)" title="Sort Z→A">&#9660;</span>` +
          `</span></th>`;
  html += `<th class="date-header">Published` +
          `<span class="header-sort">` +
          `<span class="sort-arrow sort-up ${sortCol === '__date' && sortAsc ? 'active' : ''}" onclick="sortBy('__date',true)" title="Sort oldest first">&#9650;</span>` +
          `<span class="sort-arrow sort-down ${sortCol === '__date' && !sortAsc ? 'active' : ''}" onclick="sortBy('__date',false)" title="Sort newest first">&#9660;</span>` +
          `</span></th>`;
  html += `<th class="avg-header">Avg` +
          `<span class="header-sort">` +
          `<span class="sort-arrow sort-up ${sortCol === '__avg' && sortAsc ? 'active' : ''}" onclick="sortBy('__avg',true)" title="Sort ascending">&#9650;</span>` +
          `<span class="sort-arrow sort-down ${sortCol === '__avg' && !sortAsc ? 'active' : ''}" onclick="sortBy('__avg',false)" title="Sort descending">&#9660;</span>` +
          `</span></th>`;
  for (const b of sortedBenchmarks) {
    html += `<th class="bench-header" onclick="selectBenchmark('${b}')">` +
            `<div>${dn[b] || b}</div>` +
            `<span class="col-sort-arrows">` +
            `<span class="sort-arrow sort-up ${sortCol === b && sortAsc ? 'active' : ''}" onclick="event.stopPropagation();sortBy('${b}',true)" title="Sort ascending">&#9650;</span>` +
            `<span class="sort-arrow sort-down ${sortCol === b && !sortAsc ? 'active' : ''}" onclick="event.stopPropagation();sortBy('${b}',false)" title="Sort descending">&#9660;</span>` +
            `</span></th>`;
  }
  html += "</tr></thead><tbody>";

  for (const model of sortedModels) {
    const shortName = model.substring(model.indexOf("/") + 1);
    const isActive = model === activeModelDetail;
    const rowCls = isActive ? ' class="active-row"' : "";
    html += `<tr${rowCls}>`;
    const escapedModel = model.replace(/'/g, "\\'");
    html += `<td class="model-cell" title="${model}" onclick="toggleModelDetail('${escapedModel}')">` +
            `<span class="model-name">${shortName}</span>` +
            `<span class="row-sort-arrows">` +
            `<span class="sort-arrow sort-up ${sortRow === model && sortRowAsc ? 'active' : ''}" onclick="event.stopPropagation();sortByRow('${escapedModel}',true)" title="Sort columns ascending">&#9650;</span>` +
            `<span class="sort-arrow sort-down ${sortRow === model && !sortRowAsc ? 'active' : ''}" onclick="event.stopPropagation();sortByRow('${escapedModel}',false)" title="Sort columns descending">&#9660;</span>` +
            `</td>`;
    const date = dates[model];
    if (date) {
      html += `<td class="date-cell" style="background:${recencyColor(date)}" ` +
              `title="Published ${ageLabel(date)}">${date}</td>`;
    } else {
      html += `<td class="date-cell missing-date">--</td>`;
    }
    const avg = avgScore(model);
    if (avg != null) {
      const avgPct = (avg * 100).toFixed(1);
      const bg = heatmapColor(avg);
      const fg = textColorForBg(avg);
      html += `<td class="score-cell avg-cell" style="background:${bg};color:${fg}">${avgPct}</td>`;
    } else {
      html += '<td class="missing avg-cell">--</td>';
    }
    for (const b of sortedBenchmarks) {
      const entry = dataMap[model]?.[b];
      if (entry) {
        const pct = (entry.score * 100).toFixed(1);
        const bg = heatmapColor(entry.score);
        const fg = textColorForBg(entry.score);
        // Only render a link if the exported data included a run_url — public
        // deployments strip this to avoid leaking internal MLflow URLs.
        if (entry.run_url) {
          html += `<td class="score-cell" style="background:${bg};color:${fg}">` +
                  `<a href="${entry.run_url}" target="_blank" style="color:${fg}">${pct}</a></td>`;
        } else {
          html += `<td class="score-cell" style="background:${bg};color:${fg}">${pct}</td>`;
        }
      } else {
        html += '<td class="missing">--</td>';
      }
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  container.innerHTML = html;

  // Set sticky left offsets for the date and avg columns based on actual
  // widths of the columns to their left. The date column is hidden on mobile
  // (display:none), in which case offsetWidth is 0 and avg sticks directly
  // to the model column — this is what we want.
  const modelHeader = container.querySelector("th.model-header");
  const dateHeader = container.querySelector("th.date-header");
  if (modelHeader) {
    const modelW = modelHeader.offsetWidth;
    const dateW = dateHeader ? dateHeader.offsetWidth : 0;
    container.querySelectorAll("th.date-header, td.date-cell").forEach(el => {
      el.style.left = modelW + "px";
    });
    container.querySelectorAll("th.avg-header, td.avg-cell").forEach(el => {
      el.style.left = (modelW + dateW) + "px";
    });
  }
}

function sortBy(col, asc) {
  if (sortCol === col && sortAsc === asc) {
    // clicking same arrow again → clear sort
    sortCol = null;
    sortAsc = true;
  } else {
    sortCol = col;
    sortAsc = asc;
  }
  render();
}

function sortByRow(model, asc) {
  if (sortRow === model && sortRowAsc === asc) {
    // clicking same arrow again → clear sort
    sortRow = null;
    sortRowAsc = true;
  } else {
    sortRow = model;
    sortRowAsc = asc;
  }
  render();
}

function selectBenchmark(bench) {
  // Close model detail (deselect row) and show benchmark chart
  closeModelDetail();
  destroyCharts();
  const section = document.getElementById("charts-section");
  section.innerHTML = "";
  const models = getSelected("model-select");
  section.appendChild(createBarChartCard(bench, models));
  requestAnimationFrame(() => {
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// ---------------------------------------------------------------------------
// Bar charts
// ---------------------------------------------------------------------------

function destroyCharts() {
  for (const c of chartInstances) c.destroy();
  chartInstances = [];
}

function renderCharts(models, benchmarks) {
  // Charts are now shown explicitly via selectBenchmark or showModelDetail,
  // not automatically on sort. Keep existing chart section content.
}

function chartEntries(benchmark, models) {
  const entries = [];
  for (const m of models) {
    const e = dataMap[m]?.[benchmark];
    if (e) entries.push({ model: m, score: e.score, run_url: e.run_url });
  }
  entries.sort((a, b) => b.score - a.score);
  return entries;
}

// Builds a Chart.js config for one benchmark. `onEnlarge` is called when the
// user clicks the chart outside a bar that has a run link.
function buildChartConfig(entries, highlightModel, { large = false, aspectRatio = 2.4, onEnlarge = null } = {}) {
  const NV_GREEN = "#76b900";
  const shortLabels = entries.map(e => e.model.substring(e.model.indexOf("/") + 1));
  const scores = entries.map(e => e.score * 100);

  const bgColors = entries.map(e => {
    if (highlightModel && e.model === highlightModel) return NV_GREEN;
    if (highlightModel) return "rgba(200,200,200,0.5)";
    return ylOrRdColor(e.score);
  });
  const borderColors = entries.map(e =>
    (highlightModel && e.model === highlightModel) ? "#333" : "transparent");
  const borderWidths = entries.map(e =>
    (highlightModel && e.model === highlightModel) ? 2 : 0);

  // Tick label size scales with the space available per bar.
  // Model-detail cards (highlightModel set, not enlarged) are half width, so
  // use slightly smaller labels there to reduce crowding.
  const compact = highlightModel && !large;
  const maxFont = large ? 14 : 12;
  const minFont = compact ? 7 : 8;
  const scale = compact ? 0.55 : 0.65;
  const tickFont = (ctx) => {
    const perBar = ctx.chart.width / Math.max(1, entries.length);
    return { size: Math.max(minFont, Math.min(maxFont, Math.floor(perBar * scale))) };
  };

  return {
    type: "bar",
    data: {
      labels: shortLabels,
      datasets: [{
        data: scores,
        backgroundColor: bgColors,
        borderColor: borderColors,
        borderWidth: borderWidths,
        borderRadius: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: !large,
      aspectRatio,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => entries[items[0].dataIndex].model,
            label: (item) => `${item.raw.toFixed(1)}%`,
          },
        },
        annotation: {
          annotations: {
            highLine: {
              type: "line", yMin: 80, yMax: 80,
              borderColor: "rgba(239,68,68,0.5)", borderWidth: 1.5, borderDash: [6, 4],
              label: {
                display: true, content: "High contamination", position: "end",
                color: "rgba(239,68,68,0.7)", font: { size: large ? 12 : 10 },
                backgroundColor: "transparent", yAdjust: -12,
              },
            },
            lowLine: {
              type: "line", yMin: 40, yMax: 40,
              borderColor: "rgba(118,185,0,0.4)", borderWidth: 1.5, borderDash: [6, 4],
              label: {
                display: true, content: "Low contamination", position: "end",
                color: "rgba(118,185,0,0.6)", font: { size: large ? 12 : 10 },
                backgroundColor: "transparent", yAdjust: -12,
              },
            },
          },
        },
      },
      scales: {
        y: {
          min: 0, max: 100,
          title: { display: true, text: "CoDeC Contamination Score (%)", color: "#666",
                   font: { size: large ? 13 : 12 } },
          grid: { color: "#eee" },
          ticks: { color: "#666", font: { size: large ? 12 : 11 } },
        },
        x: {
          ticks: {
            autoSkip: false,
            maxRotation: 60,
            minRotation: 30,
            font: tickFont,
            color: "#444",
          },
          grid: { display: false },
        },
      },
      onClick: (evt, elements) => {
        const url = elements.length > 0 ? entries[elements[0].index].run_url : null;
        if (url) window.open(url, "_blank");
        else if (onEnlarge) onEnlarge();
      },
      onHover: (evt, elements, chart) => {
        const onLink = elements.length > 0 && entries[elements[0].index].run_url;
        chart.canvas.style.cursor = onLink ? "pointer" : (onEnlarge ? "zoom-in" : "default");
      },
    },
  };
}

function createBarChartCard(benchmark, models, highlightModel) {
  const dn = rawData.benchmark_display_names || {};
  const label = dn[benchmark] || benchmark;
  const entries = chartEntries(benchmark, models);
  const enlarge = () => openChartModal(label, entries, highlightModel);

  const card = document.createElement("div");
  card.className = "chart-card";
  const head = document.createElement("div");
  head.className = "chart-card-head";
  const h3 = document.createElement("h3");
  h3.textContent = label;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chart-expand";
  btn.title = "Enlarge chart";
  btn.setAttribute("aria-label", "Enlarge chart");
  btn.innerHTML = "&#x2922;";
  btn.addEventListener("click", enlarge);
  head.appendChild(h3);
  head.appendChild(btn);
  card.appendChild(head);
  const canvas = document.createElement("canvas");
  card.appendChild(canvas);

  // Half-width cards in the model detail view get a taller aspect ratio so
  // rotated model names have room.
  const aspectRatio = highlightModel ? 1.7 : 2.4;
  const chart = new Chart(canvas, buildChartConfig(entries, highlightModel, { aspectRatio, onEnlarge: enlarge }));
  chartInstances.push(chart);
  return card;
}

// ---------------------------------------------------------------------------
// Chart modal (click-to-enlarge)
// ---------------------------------------------------------------------------

let modalChart = null;

function openChartModal(title, entries, highlightModel) {
  closeChartModal();
  const overlay = document.createElement("div");
  overlay.id = "chart-modal";
  overlay.innerHTML =
    `<div class="chart-modal-dialog" role="dialog" aria-modal="true">` +
    `<div class="chart-modal-head"><h3></h3>` +
    `<button type="button" class="chart-modal-close" aria-label="Close">&times;</button></div>` +
    `<div class="chart-modal-body"><canvas></canvas></div></div>`;
  overlay.querySelector("h3").textContent = title;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeChartModal(); });
  overlay.querySelector(".chart-modal-close").addEventListener("click", closeChartModal);
  document.body.appendChild(overlay);
  document.body.classList.add("modal-open");
  modalChart = new Chart(overlay.querySelector("canvas"),
                         buildChartConfig(entries, highlightModel, { large: true }));
}

function closeChartModal() {
  if (modalChart) { modalChart.destroy(); modalChart = null; }
  document.getElementById("chart-modal")?.remove();
  document.body.classList.remove("modal-open");
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeChartModal(); });

// ---------------------------------------------------------------------------
// Model detail view
// ---------------------------------------------------------------------------

function toggleModelDetail(model) {
  if (activeModelDetail === model) closeModelDetail();
  else showModelDetail(model);
}

function showModelDetail(model, scroll = true) {
  // Clear benchmark chart (deselect column)
  const chartsSection = document.getElementById("charts-section");
  chartsSection.innerHTML = "";

  activeModelDetail = model;
  const section = document.getElementById("model-detail");
  const title = document.getElementById("model-detail-title");
  const chartsDiv = document.getElementById("model-detail-charts");
  section.style.display = "block";
  title.textContent = model;
  chartsDiv.innerHTML = "";

  const benchmarks = getSelected("benchmark-select");
  const models = getSelected("model-select");

  for (const b of benchmarks) {
    if (dataMap[model]?.[b]) {
      chartsDiv.appendChild(createBarChartCard(b, models, model));
    }
  }

  renderTable(models, benchmarks);
  if (scroll) {
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function closeModelDetail() {
  activeModelDetail = null;
  document.getElementById("model-detail").style.display = "none";
  document.getElementById("model-detail-charts").innerHTML = "";
  const models = getSelected("model-select");
  const benchmarks = getSelected("benchmark-select");
  renderTable(models, benchmarks);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  setChartDefaults();
  fetchData();
  setInterval(fetchData, 600000);
});
