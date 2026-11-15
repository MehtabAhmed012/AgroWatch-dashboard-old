"""Earth Engine logic for AgroWatch. Python port of gee/AgroWatch.js.

app.py never touches `ee` directly. Every public get_* function is cached
because Earth Engine calls take seconds.
"""
import os
import threading
import time
from datetime import datetime, timezone

import ee

# ----------------------------------------------------------------- settings
BOUNDARY_ASSET = os.getenv("BOUNDARY_ASSET", "projects/semiotic-timer-429307-g6/assets/District_Boundary")
PROVINCE_FIELD = os.getenv("PROVINCE_FIELD") or None
DISTRICT_FIELD = os.getenv("DISTRICT_FIELD") or None
PROVINCE_CANDIDATES = ["PROVINCE", "Prov_Name", "PROV", "ADM1_NAME", "NAME_1", "ADM1_EN"]
DISTRICT_CANDIDATES = ["DISTRICT", "Dist_Name", "DIST", "ADM2_NAME", "NAME_2", "ADM2_EN", "NAME"]

BASE_START, BASE_END = 2001, 2018   # long-term "normal" period
FIRST_YEAR = 2019                   # first selectable season year
CLOUD_MAX = 30

S2_ID = "COPERNICUS/S2_SR_HARMONIZED"
MODIS_ID = "MODIS/061/MOD13Q1"
CHIRPS_ID = "UCSB-CHG/CHIRPS/DAILY"
WORLDCOVER_ID = "ESA/WorldCover/v200"

SEASONS = {
    "kharif": {"label": "Kharif (May-Oct)", "m1": 5, "m2": 10, "crosses": False},
    "rabi": {"label": "Rabi (Nov-Apr)", "m1": 11, "m2": 4, "crosses": True},
}

# VCI classes: 1 = normal ... 5 = extreme stress
CLASSES = [
    {"id": 1, "name": "Normal", "range": "VCI 50 and above", "color": "#1a9850"},
    {"id": 2, "name": "Low Stress", "range": "VCI 35 to 50", "color": "#fee08b"},
    {"id": 3, "name": "Moderate stress", "range": "VCI 20 to 35", "color": "#fdae61"},
    {"id": 4, "name": "Severe stress", "range": "VCI 10 to 20", "color": "#d73027"},
    {"id": 5, "name": "Extreme stress", "range": "VCI below 10", "color": "#7f0000"},
]

NDVI_PAL = ["#d73027", "#fc8d59", "#fee08b", "#d9ef8b", "#91cf60", "#1a9850", "#006837"]
ANOM_PAL = ["#8c510a", "#d8b365", "#f6e8c3", "#f5f5f5", "#c7eae5", "#5ab4ac", "#01665e"]
RAIN_PAL = ["#ffffcc", "#c7e9b4", "#7fcdbb", "#41b6c4", "#2c7fb8", "#253494"]
PCT_PAL =  ["#313695", "#1a9850", "#a6d96a", "#ffffbf", "#fee08b", "#f46d43" ,"#a50026"]

# key -> label shown on the map tabs, which analysis image it uses, unit
LAYERS = {
    "stress": {"label": "Stress", "title": "Vegetation stress (cropland)", "unit": "", "kind": "classes"},
    "s2_ndvi": {"label": "Sentinel-2 NDVI", "title": "NDVI, Sentinel-2 10 m", "unit": "", "kind": "continuous"},
    "s2_evi": {"label": "Sentinel-2 EVI", "title": "EVI, Sentinel-2 10 m", "unit": "", "kind": "continuous"},
    "modis_ndvi": {"label": "MODIS NDVI", "title": "NDVI, MODIS 250 m", "unit": "", "kind": "continuous"},
    "anomaly": {"label": "NDVI anomaly", "title": "NDVI anomaly vs 2001-2018", "unit": "", "kind": "continuous"},
    "vci": {"label": "VCI", "title": "Vegetation Condition Index", "unit": "", "kind": "continuous"},
    "rain": {"label": "Rainfall", "title": "Season rainfall", "unit": "mm", "kind": "continuous"},
    "rain_pct": {"label": "Rain % normal", "title": "Rainfall as % of normal", "unit": "%", "kind": "continuous"},
}


def layer_meta():
    return {"layers": LAYERS, "classes": CLASSES}


def _vis(layer, season):
    rain_max = 600 if season == "kharif" else 200
    return {
        "stress": {"min": 1, "max": 5, "palette": [c["color"] for c in CLASSES]},
        "s2_ndvi": {"min": 0, "max": 0.9, "palette": NDVI_PAL},
        "s2_evi": {"min": 0, "max": 0.9, "palette": NDVI_PAL},
        "modis_ndvi": {"min": 0, "max": 0.8, "palette": NDVI_PAL},
        "anomaly": {"min": -0.2, "max": 0.2, "palette": ANOM_PAL},
        "vci": {"min": 0, "max": 100, "palette": PCT_PAL},
        "rain": {"min": 0, "max": rain_max, "palette": RAIN_PAL},
        "rain_pct": {"min": 0, "max": 200, "palette": PCT_PAL},
    }[layer]


# -------------------------------------------------------------------- cache
def ttl_cache(seconds):
    """Tiny in-memory cache. Positional, hashable args only."""

    def deco(fn):
        store, lock = {}, threading.Lock()

        def wrapper(*args):
            now = time.time()
            with lock:
                hit = store.get(args)
                if hit and now - hit[0] < seconds:
                    return hit[1]
            value = fn(*args)
            with lock:
                store[args] = (now, value)
                if len(store) > 200:
                    store.pop(min(store, key=lambda k: store[k][0]))
            return value

        return wrapper

    return deco


# --------------------------------------------------------- boundary / fields
_fields = {}


def _find(props, candidates):
    lower = {p.lower(): p for p in props}
    for c in candidates:
        if c.lower() in lower:
            return lower[c.lower()]
    return None


def fields():
    """Column names of the boundary asset (detected once)."""
    if not _fields:
        props = ee.FeatureCollection(BOUNDARY_ASSET).first().propertyNames().getInfo()
        district = DISTRICT_FIELD or _find(props, DISTRICT_CANDIDATES)
        if not district:
            raise RuntimeError(
                f"No district-name column found in {BOUNDARY_ASSET}. Columns: {', '.join(props)}. "
                "Set DISTRICT_FIELD in .env."
            )
        _fields.update(province=PROVINCE_FIELD or _find(props, PROVINCE_CANDIDATES), district=district)
    return _fields


def _base_fc(province):
    f = fields()
    fc = ee.FeatureCollection(BOUNDARY_ASSET).filter(ee.Filter.notNull([f["district"]]))
    if f["province"] and province:
        fc = fc.filter(ee.Filter.eq(f["province"], province))
    return fc


def _region_fc(province, district):
    fc = _base_fc(province)
    if district:
        fc = fc.filter(ee.Filter.eq(fields()["district"], district))
    return fc


@ttl_cache(3600)
def list_provinces():
    f = fields()
    if not f["province"]:
        return []
    fc = ee.FeatureCollection(BOUNDARY_ASSET).filter(ee.Filter.notNull([f["province"]]))
    return fc.aggregate_array(f["province"]).distinct().sort().getInfo()


@ttl_cache(3600)
def list_districts(province):
    return _base_fc(province).aggregate_array(fields()["district"]).distinct().sort().getInfo()


@ttl_cache(21600)
def get_boundary(province, district):
    """Simplified GeoJSON outline with a `name` property (district name)."""
    name_field = fields()["district"]
    fc = _region_fc(province, district).map(
        lambda f: ee.Feature(f.geometry().simplify(500), {"name": f.get(name_field)})
    )
    return fc.getInfo()


# ------------------------------------------------------------ imagery helpers
def _crop_mask():
    return ee.Image(ee.ImageCollection(WORLDCOVER_ID).first()).select("Map").eq(40).selfMask()


def season_range(year, season):
    """Rabi 2025 = 1 Nov 2025 -> 30 Apr 2026."""
    cfg = SEASONS[season]
    y = ee.Number(year)
    end_year = y.add(1) if cfg["crosses"] else y
    return ee.Date.fromYMD(y, cfg["m1"], 1), ee.Date.fromYMD(end_year, cfg["m2"], 1).advance(1, "month")


def _mask_index_s2(img):
    scl = img.select("SCL")
    ok = scl.neq(3).And(scl.neq(8)).And(scl.neq(9)).And(scl.neq(10)).And(scl.neq(11))
    refl = img.select(["B2", "B4", "B8"]).divide(10000)
    ndvi = refl.normalizedDifference(["B8", "B4"]).rename("NDVI")
    evi = refl.expression(
        "2.5 * (NIR - RED) / (NIR + 6.0 * RED - 7.5 * BLUE + 1.0)",
        {"NIR": refl.select("B8"), "RED": refl.select("B4"), "BLUE": refl.select("B2")},
    ).rename("EVI")
    return ndvi.addBands(evi).updateMask(ok).copyProperties(img, ["system:time_start"])


def _guard(col, bands):
    """Add one fully-masked placeholder image so an empty collection (season not finished,
    data lag) still returns an image with the right band names instead of crashing."""
    ph = ee.Image.constant([0] * len(bands)).rename(bands).selfMask()
    return col.merge(ee.ImageCollection([ph]))


def _modis_season(year, season):
    start, end = season_range(year, season)

    def prep(img):
        good = img.select("SummaryQA").lte(1)
        return (
            img.select(["NDVI", "EVI"]).multiply(0.0001).updateMask(good)
            .copyProperties(img, ["system:time_start"])
        )

    col = ee.ImageCollection(MODIS_ID).filterDate(start, end).map(prep)
    return _guard(col, ["NDVI", "EVI"]).mean()


def _rain_season(year, season):
    start, end = season_range(year, season)
    col = ee.ImageCollection(CHIRPS_ID).filterDate(start, end).select("precipitation")
    return _guard(col, ["precipitation"]).sum().rename("rain")


def _baseline(fn, season):
    return ee.ImageCollection(ee.List.sequence(BASE_START, BASE_END).map(lambda y: fn(y, season)))


def _analysis(province, district, year, season):
    """Build every analysis image (lazy - nothing is computed until requested)."""
    region_fc = _region_fc(province, district)
    geom = region_fc.geometry()
    start, end = season_range(year, season)

    s2 = (
        ee.ImageCollection(S2_ID).filterBounds(geom).filterDate(start, end)
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", CLOUD_MAX))
        .map(_mask_index_s2).median()
    )

    cur = _modis_season(year, season)
    ndvi, evi = cur.select("NDVI"), cur.select("EVI")
    base = _baseline(_modis_season, season).select("NDVI")
    b_mean, b_min, b_max = base.mean(), base.min(), base.max()

    anomaly = ndvi.subtract(b_mean).rename("anomaly")
    vci = ndvi.subtract(b_min).divide(b_max.subtract(b_min)).multiply(100).clamp(0, 100).rename("VCI")
    stress = (
        ee.Image(0)
        .where(vci.gte(50), 1)
        .where(vci.gte(35).And(vci.lt(50)), 2)
        .where(vci.gte(20).And(vci.lt(35)), 3)
        .where(vci.gte(10).And(vci.lt(20)), 4)
        .where(vci.lt(10), 5)
        .updateMask(vci.gte(0)).rename("stress")
    )

    rain = _rain_season(year, season)
    rain_base = _baseline(_rain_season, season).mean()
    rain_pct = rain.divide(rain_base).multiply(100).updateMask(rain_base.gt(10)).rename("rain_pct")

    return {
        "geom": geom, "ndvi": ndvi, "evi": evi, "vci": vci, "stress": stress, "rain": rain,
        "rain_pct": rain_pct, "b_min": b_min, "b_max": b_max,
        "images": {
            "stress": stress, "s2_ndvi": s2.select("NDVI"), "s2_evi": s2.select("EVI"),
            "modis_ndvi": ndvi, "anomaly": anomaly, "vci": vci, "rain": rain, "rain_pct": rain_pct,
        },
    }


def _rr(img, reducer, geom, scale):
    return img.reduceRegion(reducer=reducer, geometry=geom, scale=scale,
                            maxPixels=1e13, bestEffort=True, tileScale=8)


# ---------------------------------------------------------------- public API
@ttl_cache(1800)
def get_tiles(layer, province, district, year, season, crop):
    a = _analysis(province, district, year, season)
    img = a["images"][layer]
    if crop:
        img = img.updateMask(_crop_mask())
    vis = _vis(layer, season)
    ee_vis = {**vis, "palette": [c.lstrip("#") for c in vis["palette"]]}
    url = img.clip(a["geom"]).getMapId(ee_vis)["tile_fetcher"].url_format
    return {"url": url, "vis": vis, **LAYERS[layer], "classes": CLASSES}


@ttl_cache(21600)
def get_stats(province, district, year, season):
    a = _analysis(province, district, year, season)
    geom, crop = a["geom"], _crop_mask()
    area_ha = ee.Image.pixelArea().divide(10000)
    raw = ee.Dictionary({
        "groups": _rr(area_ha.addBands(a["stress"]).updateMask(crop),
                      ee.Reducer.sum().group(groupField=1, groupName="class"), geom, 250).get("groups"),
        "totalHa": _rr(area_ha.updateMask(crop), ee.Reducer.sum(), geom, 250).get("area"),
        "means": _rr(a["ndvi"].addBands([a["evi"], a["vci"], a["rain"], a["rain_pct"]]).updateMask(crop),
                     ee.Reducer.mean(), geom, 1000),
    }).getInfo()

    by_class = {int(g["class"]): g["sum"] for g in (raw.get("groups") or [])}
    monitored = sum(by_class.values())
    classes = []
    for c in CLASSES:
        ha = by_class.get(c["id"], 0.0)
        classes.append({**c, "ha": ha, "pct": 100 * ha / monitored if monitored else 0})
    stressed = sum(by_class.get(i, 0.0) for i in (3, 4, 5))
    return {
        "total_ha": raw.get("totalHa"), "monitored_ha": monitored, "classes": classes,
        "stressed_ha": stressed, "stressed_pct": 100 * stressed / monitored if monitored else 0,
        "means": raw.get("means") or {},
    }


@ttl_cache(21600)
def get_series(province, district, year, season):
    """Seasonal mean NDVI / EVI / VCI / rainfall for every year from 2001 to `year`.

    Every year is stacked as bands of one image so Earth Engine computes everything in a
    single pass (the baseline min/max is built once, not once per year)."""
    a = _analysis(province, district, year, season)
    geom, crop = a["geom"], _crop_mask()
    years = list(range(BASE_START, int(year) + 1))

    ndvi_b, evi_b, rain_b = [], [], []
    for y in years:
        cur = _modis_season(y, season)
        ndvi_b.append(cur.select("NDVI").rename(f"NDVI_{y}"))
        evi_b.append(cur.select("EVI").rename(f"EVI_{y}"))
        rain_b.append(_rain_season(y, season).rename(f"rain_{y}"))

    ndvi = ee.Image.cat(ndvi_b)
    vci = (ndvi.subtract(a["b_min"]).divide(a["b_max"].subtract(a["b_min"]))
           .multiply(100).clamp(0, 100).rename([f"VCI_{y}" for y in years]))

    m = _rr(ee.Image.cat([ndvi, ee.Image.cat(evi_b), vci]).updateMask(crop),
            ee.Reducer.mean(), geom, 1000).getInfo()
    r = _rr(ee.Image.cat(rain_b), ee.Reducer.mean(), geom, 5566).getInfo()

    rows = [{"year": y, "NDVI": m.get(f"NDVI_{y}"), "EVI": m.get(f"EVI_{y}"),
             "VCI": m.get(f"VCI_{y}"), "rain": r.get(f"rain_{y}")} for y in years]
    return {"rows": rows, "base": [BASE_START, BASE_END]}


@ttl_cache(21600)
def get_rain_monthly(province, district, year):
    """Monthly rainfall for `year` against the 2001-2018 monthly normal (mm)."""
    geom = _region_fc(province, district).geometry()
    chirps = ee.ImageCollection(CHIRPS_ID).select("precipitation")

    def month_sum(y, mo):
        s0 = ee.Date.fromYMD(y, mo, 1)
        return _guard(chirps.filterDate(s0, s0.advance(1, "month")), ["precipitation"]).sum()

    bands = []
    for mo in range(1, 13):
        obs = month_sum(int(year), mo).rename(f"obs_{mo}")
        normal = ee.ImageCollection(
            [month_sum(by, mo) for by in range(BASE_START, BASE_END + 1)]).mean().rename(f"normal_{mo}")
        bands += [obs, normal]

    d = _rr(ee.Image.cat(bands), ee.Reducer.mean(), geom, 5566).getInfo()
    rows = [{"month": mo, "observed": d.get(f"obs_{mo}"), "normal": d.get(f"normal_{mo}")}
            for mo in range(1, 13)]
    return {"rows": rows}


@ttl_cache(3600)
def get_sources():
    """Latest observation date per satellite source (freshness indicator)."""
    now = ee.Date(int(time.time() * 1000))

    def latest(coll_id, days):
        try:
            col = ee.ImageCollection(coll_id).filterDate(now.advance(-days, "day"), now)
            ms = col.aggregate_max("system:time_start").getInfo()
            return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d") if ms else None
        except Exception:
            return None

    return [
        {"id": "s2", "name": "Sentinel-2", "note": "10 m optical imagery, NDVI and EVI maps", "latest": latest(S2_ID, 30)},
        {"id": "modis", "name": "MODIS", "note": "250 m, 16-day NDVI and EVI, 2001 baseline", "latest": latest(MODIS_ID, 90)},
        {"id": "chirps", "name": "CHIRPS", "note": "5 km daily rainfall", "latest": latest(CHIRPS_ID, 90)},
        {"id": "worldcover", "name": "WorldCover", "note": "ESA 2021 cropland mask (static)", "latest": None},
        {"id": "boundary", "name": "Districts", "note": "Your District_Boundary asset", "latest": None},
    ]


# ------------------------------------------------------------------ insights
def build_insights(stats, series):
    """Rule-based drought risk and plain-language alerts (no ML, easy to tune)."""
    m = stats.get("means") or {}
    vci, rain_pct = m.get("VCI"), m.get("rain_pct")
    sp = stats.get("stressed_pct") or 0.0

    if sp >= 40 or (vci is not None and vci < 20):
        level = "Severe"
    elif sp >= 25 or (vci is not None and vci < 35):
        level = "High"
    elif sp >= 10 or (vci is not None and vci < 50):
        level = "Moderate"
    else:
        level = "Low"

    msgs = []
    ha = f"{stats.get('stressed_ha') or 0:,.0f}"
    if sp >= 25:
        msgs.append({"level": "alert", "title": "Widespread crop stress",
                     "text": f"{sp:.1f}% of cropland ({ha} ha) shows moderate to extreme vegetation stress."})
    elif sp >= 10:
        msgs.append({"level": "warn", "title": "Local crop stress",
                     "text": f"{sp:.1f}% of cropland ({ha} ha) is under moderate or worse stress."})
    else:
        msgs.append({"level": "ok", "title": "Crops in good condition",
                     "text": f"Only {sp:.1f}% of cropland shows moderate or worse stress."})

    if rain_pct is not None:
        if rain_pct < 60:
            msgs.append({"level": "alert", "title": "Rainfall deficit",
                         "text": f"Season rainfall is {rain_pct:.0f}% of the {BASE_START}-{BASE_END} normal."})
        elif rain_pct < 85:
            msgs.append({"level": "warn", "title": "Below-normal rainfall",
                         "text": f"Season rainfall is {rain_pct:.0f}% of normal."})
        elif rain_pct > 130:
            msgs.append({"level": "warn", "title": "Above-normal rainfall",
                         "text": f"Season rainfall is {rain_pct:.0f}% of normal. Check for waterlogging."})
        else:
            msgs.append({"level": "ok", "title": "Rainfall near normal",
                         "text": f"Season rainfall is {rain_pct:.0f}% of normal."})

    rows = (series or {}).get("rows") or []
    base_vals = [r["NDVI"] for r in rows if r.get("NDVI") is not None and r["year"] <= BASE_END]
    cur = rows[-1].get("NDVI") if rows else None
    if cur is not None and base_vals:
        delta = cur - sum(base_vals) / len(base_vals)
        if delta <= -0.05:
            msgs.append({"level": "warn", "title": "Greenness below normal",
                         "text": f"Mean NDVI is {abs(delta):.2f} lower than the {BASE_START}-{BASE_END} average."})
        elif delta >= 0.05:
            msgs.append({"level": "ok", "title": "Greenness above normal",
                         "text": f"Mean NDVI is {delta:.2f} higher than the {BASE_START}-{BASE_END} average."})
        else:
            msgs.append({"level": "info", "title": "Greenness near normal",
                         "text": f"Mean NDVI is within 0.05 of the {BASE_START}-{BASE_END} average."})

    worst = sum(c["ha"] for c in stats.get("classes", []) if c["id"] >= 4)
    if worst > 0:
        msgs.append({"level": "info", "title": "Where to look",
                     "text": f"Severe or extreme stress covers {worst:,.0f} ha. Open the Stress layer and zoom in."})

    return {"risk": level, "stressed_pct": sp, "health_index": vci, "messages": msgs}
#updated