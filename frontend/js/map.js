// Leaflet map: basemaps, Earth Engine tile layer, district outlines, legend.
let map, geeLayer, boundaryLayer, onPick;
let opacity = 0.85;
let current = "dark";
const base = {};

export function initMap(pickHandler) {
  onPick = pickHandler;
  map = L.map("map", { zoomControl: true }).setView([30.4, 69.4], 6);
  base.dark = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO", subdomains: "abcd", maxZoom: 19, zIndex: 1,
  });
  base.sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Tiles &copy; Esri", maxZoom: 19, zIndex: 1,
  });
  base.dark.addTo(map);
}

export function toggleBasemap() {
  map.removeLayer(base[current]);
  current = current === "dark" ? "sat" : "dark";
  base[current].addTo(map);
}

export function setTiles(url) {
  if (geeLayer) map.removeLayer(geeLayer);
  geeLayer = L.tileLayer(url, { opacity, maxZoom: 19, zIndex: 5 }).addTo(map);
}

export function setOpacity(value) {
  opacity = Number(value);
  if (geeLayer) geeLayer.setOpacity(opacity);
}

export function setBoundary(geojson, selected) {
  if (boundaryLayer) map.removeLayer(boundaryLayer);
  const single = geojson.features.length === 1;
  boundaryLayer = L.geoJSON(geojson, {
    style: (f) => ({
      color: f.properties.name === selected || single ? "#ffffff" : "#6fb1ff",
      weight: f.properties.name === selected || single ? 2.2 : 1,
      fillOpacity: 0,
    }),
    onEachFeature: (f, layer) => {
      const name = f.properties.name;
      if (name) layer.bindTooltip(name, { sticky: true });
      layer.on("mouseover", () => layer.setStyle({ weight: 2.5, color: "#22d3ee" }));
      layer.on("mouseout", () => boundaryLayer.resetStyle(layer));
      layer.on("click", () => name && onPick && onPick(name));
    },
  }).addTo(map);
  boundaryLayer.bringToFront();
  fitHome();
}

export function fitHome() {
  if (boundaryLayer) map.fitBounds(boundaryLayer.getBounds(), { padding: [24, 24] });
}

export function renderLegend(el, info) {
  if (!info) { el.innerHTML = ""; return; }
  const title = `<div class="legend-title">${info.title}</div>`;
  if (info.kind === "classes") {
    el.innerHTML = title + info.classes.map((c) =>
      `<div class="legend-row"><i style="background:${c.color}"></i>${c.name}<span>${c.range}</span></div>`).join("");
  } else {
    const { min, max, palette } = info.vis;
    const u = info.unit ? ` ${info.unit}` : "";
    el.innerHTML = `${title}<div class="legend-bar" style="background:linear-gradient(90deg,${palette.join(",")})"></div>` +
      `<div class="legend-scale"><span>${min}${u}</span><span>${max}${u}</span></div>`;
  }
}
