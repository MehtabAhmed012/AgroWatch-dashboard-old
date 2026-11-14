// Chart.js helpers. Every chart is keyed by its canvas id so it can be redrawn.
const instances = {};
const C = { text: "#9db2d3", grid: "rgba(120,150,200,.13)", blue: "#2f8cff", green: "#34d399",
            cyan: "#22d3ee", amber: "#f59e0b", orange: "#fb923c", red: "#ef4444" };
export const RISK_COLOR = { Low: C.green, Moderate: C.amber, High: C.orange, Severe: C.red };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function initCharts() {
  Chart.defaults.color = C.text;
  Chart.defaults.font.family = "'Manrope', system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.borderColor = C.grid;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
}

function make(id, config) {
  if (instances[id]) instances[id].destroy();
  instances[id] = new Chart(document.getElementById(id), config);
}

export function sparkline(canvas, values, color) {
  const key = canvas.id || (canvas.id = "spark-" + Math.random().toString(36).slice(2));
  make(key, {
    type: "line",
    data: { labels: values.map((_, i) => i), datasets: [{ data: values, borderColor: color, borderWidth: 1.6,
      pointRadius: 0, tension: 0.35, fill: true, backgroundColor: color + "26", spanGaps: true }] },
    options: { responsive: false, animation: false, events: [],
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } } },
  });
}

export function renderSeasonal(id, rows) {
  make(id, {
    type: "line",
    data: { labels: rows.map((r) => r.year),
      datasets: [
        { label: "NDVI", data: rows.map((r) => r.NDVI), borderColor: C.green, backgroundColor: C.green, tension: 0.25, pointRadius: 2.5, borderWidth: 2, spanGaps: true },
        { label: "EVI", data: rows.map((r) => r.EVI), borderColor: C.cyan, backgroundColor: C.cyan, tension: 0.25, pointRadius: 2.5, borderWidth: 2, spanGaps: true },
      ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      scales: { x: { ticks: { maxRotation: 60, autoSkip: true, maxTicksLimit: 9 } }, y: { title: { display: true, text: "Index" } } } },
  });
}

export function renderVci(id, rows) {
  const color = (v) => (v == null ? C.grid : v >= 50 ? C.green : v >= 35 ? C.amber : v >= 20 ? C.orange : C.red);
  make(id, {
    type: "bar",
    data: { labels: rows.map((r) => r.year), datasets: [{ label: "VCI", data: rows.map((r) => r.VCI), backgroundColor: rows.map((r) => color(r.VCI)), borderRadius: 3 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { maxRotation: 60, autoSkip: true, maxTicksLimit: 9 } }, y: { min: 0, max: 100 } } },
  });
}

export function renderRain(id, rows) {
  const sorted = rows.slice().sort((a, b) => a.month - b.month);
  make(id, {
    data: { labels: sorted.map((r) => MONTHS[r.month - 1]),
      datasets: [
        { type: "bar", label: "Observed", data: sorted.map((r) => r.observed), backgroundColor: C.blue, borderRadius: 3 },
        { type: "line", label: "Normal", data: sorted.map((r) => r.normal), borderColor: C.amber, backgroundColor: C.amber, tension: 0.3, pointRadius: 2, borderWidth: 2 },
      ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      scales: { y: { title: { display: true, text: "mm" } } } },
  });
}

export function renderDonut(id, classes) {
  make(id, {
    type: "doughnut",
    data: { labels: classes.map((c) => c.name), datasets: [{ data: classes.map((c) => Math.round(c.ha)), backgroundColor: classes.map((c) => c.color), borderColor: "#0a1730", borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: "62%",
      plugins: { legend: { position: "right" }, tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.parsed.toLocaleString("en-US")} ha` } } } },
  });
}

export function renderGauge(id, pct, level) {
  const color = RISK_COLOR[level] || C.blue;
  const p = Math.max(0, Math.min(100, pct || 0));
  make(id, {
    type: "doughnut",
    data: { datasets: [{ data: [p, 100 - p], backgroundColor: [color, "rgba(120,150,200,.16)"], borderWidth: 0 }] },
    options: { responsive: false, cutout: "78%", animation: false, events: [],
      plugins: { legend: { display: false }, tooltip: { enabled: false } } },
  });
}
