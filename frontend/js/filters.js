// Filter bar + map layer tabs.
const $ = (id) => document.getElementById(id);

function fill(select, items) {
  select.replaceChildren(...items.map(([label, value]) => new Option(label, value)));
}

export function initFilters(meta, handlers) {
  const hasProvince = meta.provinces.length > 0;
  $("province-field").hidden = !hasProvince;
  if (hasProvince) {
    fill($("province"), meta.provinces.map((p) => [p, p]));
    $("province").value = meta.provinces.includes(meta.default_province) ? meta.default_province : meta.provinces[0];
    $("province").addEventListener("change", handlers.onProvince);
  }
  fill($("year"), meta.years.slice().reverse().map((y) => [String(y), String(y)]));
  $("year").value = String(meta.default_year);

  const seg = $("season-seg");
  seg.replaceChildren(...meta.seasons.map((s, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.season = s.id;
    b.textContent = s.label.split(" ")[0];
    b.title = s.label;
    if (i === 0) b.classList.add("on");
    b.addEventListener("click", () => {
      seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    });
    return b;
  }));

  $("apply").addEventListener("click", handlers.onApply);
}

export function setDistricts(list, selected) {
  fill($("district"), [["All districts", ""], ...list.map((d) => [d, d])]);
  $("district").value = selected && list.includes(selected) ? selected : "";
}

export function selectDistrict(name) {
  const sel = $("district");
  if ([...sel.options].some((o) => o.value === name)) { sel.value = name; return true; }
  return false;
}

export function getFilters() {
  const on = document.querySelector("#season-seg button.on");
  return {
    province: $("province-field").hidden ? "" : $("province").value,
    district: $("district").value,
    year: $("year").value,
    season: on ? on.dataset.season : "kharif",
    crop: $("crop").checked,
  };
}

export function buildLayerTabs(layers, active, onPick) {
  const wrap = $("layer-tabs");
  wrap.replaceChildren(...Object.entries(layers).map(([key, v]) => {
    const b = document.createElement("button");
    b.className = "tab" + (key === active ? " active" : "");
    b.dataset.layer = key;
    b.textContent = v.label;
    b.addEventListener("click", () => onPick(key));
    return b;
  }));
}

export function setActiveTab(key) {
  document.querySelectorAll("#layer-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.layer === key));
}
