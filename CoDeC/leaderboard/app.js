/* ===== CoDeC (Contamination Detection via Context) Leaderboard — Static Frontend ===== */

let rawData = null;
let dataMap = {};
let sortCol = null;
let sortAsc = true;
let sortRow = null;           // model key for sorting columns
let sortRowAsc = true;
let activeModelDetail = null;
let chartInstances = [];

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
// Data fetching — static JSON version
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
  render();
}

// ---------------------------------------------------------------------------
// Checkbox panel helpers
// ---------------------------------------------------------------------------

function populateSelect(id, items, previousSelection, displayNames) {
  const panel = document.getElementById(id);
  panel.innerHTML = "";

  if (id === "model-select") {
    const groups = {};
    for (const item of items) {
      const slash = item.indexOf("/");
      const vendor = slash > 0 ? item.substring(0, slash) : "Checkpoints";
      if (!groups[vendor]) groups[vendor] = [];
      groups[vendor].push(item);
    }
    for (const [vendor, models] of Object.entries(groups).sort()) {
      const group = document.createElement("div");
      group.className = "family-group";

      // Family header
      const header = document.createElement("div");
      header.className = "family-header";

      const familyCb = document.createElement("input");
      familyCb.type = "checkbox";
      familyCb.className = "family-cb";

      const chevron = document.createElement("span");
      chevron.className = "family-chevron";
      chevron.textContent = "\u25BC";
      chevron.addEventListener("click", (e) => {
        e.stopPropagation();
        header.classList.toggle("collapsed");
        body.classList.toggle("collapsed");
      });

      const label = document.createElement("span");
      label.className = "family-label";
      label.textContent = vendor;

      header.appendChild(familyCb);
      header.appendChild(label);
      header.appendChild(chevron);

      // Clicking the header text area toggles collapse
      header.addEventListener("click", (e) => {
        if (e.target === familyCb) return;
        header.classList.toggle("collapsed");
        body.classList.toggle("collapsed");
      });

      // Family body
      const body = document.createElement("div");
      body.className = "family-body";

      for (const m of models) {
        const shortName = m.substring(m.indexOf("/") + 1);
        const lbl = document.createElement("label");
        lbl.className = "filter-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = m;
        cb.checked = previousSelection.length === 0 || previousSelection.includes(m);
        cb.addEventListener("change", () => {
          updateFamilyCheckbox(familyCb, body);
          render();
        });
        const span = document.createElement("span");
        span.textContent = shortName;
        lbl.appendChild(cb);
        lbl.appendChild(span);
        body.appendChild(lbl);
      }

      // Family checkbox logic
      familyCb.addEventListener("change", () => {
        const checked = familyCb.checked;
        body.querySelectorAll("input[type=\"checkbox\"]").forEach(cb => { cb.checked = checked; });
        familyCb.indeterminate = false;
        render();
      });

      group.appendChild(header);
      group.appendChild(body);
      panel.appendChild(group);

      // Set initial family checkbox state
      updateFamilyCheckbox(familyCb, body);
    }
  } else {
    for (const item of items) {
      const lbl = document.createElement("label");
      lbl.className = "filter-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = item;
      cb.checked = previousSelection.length === 0 || previousSelection.includes(item);
      cb.addEventListener("change", () => render());
      const span = document.createElement("span");
      span.textContent = (displayNames && displayNames[item]) || item;
      lbl.appendChild(cb);
      lbl.appendChild(span);
      panel.appendChild(lbl);
    }
  }
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
  render();
}

function selectNone(id) {
  document.querySelectorAll(`#${id} input[type="checkbox"]`).forEach(cb => { cb.checked = false; cb.indeterminate = false; });
  render();
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

  let sortedModels = [...models];
  if (sortCol === "__model") {
    sortedModels.sort((a, b) => sortAsc ? a.localeCompare(b) : b.localeCompare(a));
  } else if (sortCol === "__avg") {
    sortedModels.sort((a, b) => {
      const sa = avgScore(a) ?? -1;
      const sb = avgScore(b) ?? -1;
      return sortAsc ? sa - sb : sb - sa;
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
          `<span class="row-sort-arrows header-sort">` +
          `<span class="sort-arrow sort-up ${sortCol === '__model' && sortAsc ? 'active' : ''}" onclick="sortBy('__model',true)" title="Sort A→Z">&#9650;</span>` +
          `<span class="sort-arrow sort-down ${sortCol === '__model' && !sortAsc ? 'active' : ''}" onclick="sortBy('__model',false)" title="Sort Z→A">&#9660;</span>` +
          `</span></th>`;
  html += `<th class="avg-header">Avg` +
          `<span class="row-sort-arrows header-sort">` +
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
        html += `<td class="score-cell" style="background:${bg};color:${fg}">` +
                `<a href="${entry.run_url}" target="_blank" style="color:${fg}">${pct}</a></td>`;
      } else {
        html += '<td class="missing">--</td>';
      }
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  container.innerHTML = html;

  // Set sticky left offset for avg column based on actual model column width
  const modelHeader = container.querySelector("th.model-header");
  if (modelHeader) {
    const left = modelHeader.offsetWidth + "px";
    container.querySelectorAll("th.avg-header, td.avg-cell").forEach(el => {
      el.style.left = left;
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

function createBarChartCard(benchmark, models, highlightModel) {
  const dn = rawData.benchmark_display_names || {};
  const label = dn[benchmark] || benchmark;

  const entries = [];
  for (const m of models) {
    const e = dataMap[m]?.[benchmark];
    if (e) entries.push({ model: m, score: e.score, run_url: e.run_url });
  }
  entries.sort((a, b) => b.score - a.score);

  const card = document.createElement("div");
  card.className = "chart-card";
  const h3 = document.createElement("h3");
  h3.textContent = label;
  card.appendChild(h3);
  const canvas = document.createElement("canvas");
  card.appendChild(canvas);

  const shortLabels = entries.map(e => e.model.substring(e.model.indexOf("/") + 1));
  const scores = entries.map(e => e.score * 100);

  const NV_GREEN = "#76b900";
  const NV_GREEN_DIM = "rgba(118,185,0,0.25)";

  const bgColors = entries.map(e => {
    if (highlightModel && e.model === highlightModel) return NV_GREEN;
    if (highlightModel) return "rgba(200,200,200,0.5)";
    return ylOrRdColor(e.score);
  });
  const borderColors = entries.map(e => {
    if (highlightModel && e.model === highlightModel) return "#333";
    return "transparent";
  });
  const borderWidths = entries.map(e => {
    return (highlightModel && e.model === highlightModel) ? 2 : 0;
  });

  const chart = new Chart(canvas, {
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
      maintainAspectRatio: true,
      aspectRatio: 2.2,
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
                color: "rgba(239,68,68,0.7)", font: { size: 10 },
                backgroundColor: "transparent", yAdjust: -12,
              },
            },
            lowLine: {
              type: "line", yMin: 40, yMax: 40,
              borderColor: "rgba(118,185,0,0.4)", borderWidth: 1.5, borderDash: [6, 4],
              label: {
                display: true, content: "Low contamination", position: "end",
                color: "rgba(118,185,0,0.6)", font: { size: 10 },
                backgroundColor: "transparent", yAdjust: -12,
              },
            },
          },
        },
      },
      scales: {
        y: {
          min: 0, max: 100,
          title: { display: true, text: "Score (%)", color: "#666" },
          grid: { color: "#eee" },
          ticks: { color: "#666" },
        },
        x: {
          ticks: {
            autoSkip: false,
            maxRotation: 60,
            minRotation: 30,
            font: { size: Math.max(3, Math.min(9, Math.floor(300 / entries.length))) },
            color: "#666",
          },
          grid: { display: false },
        },
      },
      onClick: (evt, elements) => {
        if (elements.length > 0) {
          window.open(entries[elements[0].index].run_url, "_blank");
        }
      },
    },
  });
  chartInstances.push(chart);
  return card;
}

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
});
