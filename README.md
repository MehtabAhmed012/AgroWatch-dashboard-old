# AgroWatch - Agriculture and drought monitoring

Which agricultural regions are experiencing vegetation stress?

A Flask API runs Google Earth Engine (GEE) analysis. A static dashboard (Leaflet map, Chart.js charts) shows the results.

```
Browser (frontend)  --fetch-->  Flask API (backend)  --ee.*-->  Google Earth Engine
 map, KPIs, charts              gee_processor.py                 Sentinel-2, MODIS, CHIRPS,
                                                                 WorldCover, your District_Boundary
```

## Project structure

```
agrowatch-dashboard/
├── gee/AgroWatch.js          Code Editor version of the same analysis (already working for you)
├── frontend/
│   ├── index.html            layout: top nav, filter bar, map, KPI cards, side panels, charts
│   ├── css/style.css         dark control-room theme, responsive
│   ├── js/main.js            API calls, KPI cards, insights, wiring
│   ├── js/map.js             Leaflet: basemaps, GEE tiles, district outlines, legend
│   ├── js/charts.js          sparklines, trend, VCI bars, rainfall, donut, risk gauge
│   ├── js/filters.js         region/district/year/season filters, layer tabs
│   └── assets/favicon.svg
├── backend/
│   ├── app.py                routes, validation, errors
│   ├── gee_processor.py      all Earth Engine logic + rule-based insights
│   ├── authentication.py     GEE login (service account) + optional dashboard login
│   ├── requirements.txt
│   └── .env.example
└── README.md
```

## What the dashboard shows

| Area | Content |
|---|---|
| Map tabs | Stress classes, Sentinel-2 NDVI and EVI, MODIS NDVI, NDVI anomaly, VCI, rainfall, rainfall % of normal |
| KPI cards | Cropland area, mean NDVI (with sparkline), crop health index (VCI), season rainfall, % cropland under stress |
| Risk gauge and insights | Low / Moderate / High / Severe drought risk, plus plain-language alerts |
| Charts | NDVI and EVI by season since 2001, VCI by season, monthly rainfall vs normal, stress class share |
| Filters | Region, district (or click a district on the map), season year, Kharif or Rabi, cropland-only mask |

How the numbers work:
- **VCI** = (NDVI - min) / (max - min) x 100, using MODIS NDVI for the same season in 2001 to 2018.
- **Stress classes** come from VCI: 50+ normal, 35 to 50 watch, 20 to 35 moderate, 10 to 20 severe, below 10 extreme.
- **Rainfall % of normal** compares the season total (CHIRPS) with the 2001 to 2018 average.
- **Cropland** is ESA WorldCover class 40. Statistics are sampled at 250 m to 1 km, so treat areas as estimates.
- **Risk level** (rules in `build_insights`): Severe if 40% or more cropland is stressed or mean VCI is below 20; High at 25% or VCI below 35; Moderate at 10% or VCI below 50; otherwise Low. Edit the numbers to suit you.

## Integration checklist

1. **Earth Engine project.** A Google Cloud project registered for Earth Engine, with the Earth Engine API enabled. Put its ID in `GEE_PROJECT`.
2. **Service account** (production). Create it, make a JSON key, and register it for Earth Engine. Give it the Earth Engine Resource Viewer role on the project.
3. **Share the boundary asset.** In the Code Editor Assets tab, share `District_Boundary` with the service account email (Reader). Without this, the backend cannot read your districts.
4. **Boundary columns.** The asset needs a district-name column. A province column is optional. Names are auto-detected; otherwise set `PROVINCE_FIELD` and `DISTRICT_FIELD` in `.env`.
5. **Backend hosting.** Render, Railway, Google Cloud Run or similar. Use HTTPS and a gunicorn timeout of 300 s.
6. **Hosting.** Simplest: deploy the backend and it serves the dashboard too. To host the `frontend/` folder separately (Netlify, GitHub Pages, your own site), set `window.AGROWATCH_API_BASE` in `index.html` to the backend URL.
7. **CORS.** Add the exact frontend origin to `ALLOWED_ORIGINS`.
8. **Website link.** Embed with an iframe, or add the dashboard URL to your site menu.
9. **Login (optional).** Set `AUTH_ENABLED=true`, a long `JWT_SECRET`, `DASH_USER` and `DASH_PASS_HASH`.
10. **Earth Engine quota and billing.** Check your project's commercial or non-commercial use tier. Public dashboards can use a lot of compute.
11. **Basemap terms.** The dark basemap is CARTO and the satellite basemap is Esri. Both need attribution (already shown) and have usage limits. Swap in your own tiles for heavy traffic.

## Run locally (Windows, macOS, Linux)

The backend also serves the dashboard, so there is one terminal and one address.

```bash
cd backend
python -m venv venv
venv\Scripts\activate            # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
earthengine authenticate          # one time: sign in with the Google account that owns the asset
python app.py
```

Open **http://localhost:5000**.

`backend/.env` is already filled in with your project (`semiotic-timer-429307-g6`) and asset path. Change it only if you use a different project.

The first load of a province can take 30 to 90 seconds because Earth Engine computes statistics over 25 seasons. Results are cached for 6 hours, so repeats are fast. Pick a single district for quicker results.

## API

| Endpoint | Params | Returns |
|---|---|---|
| `GET /api/meta` | - | provinces, years, seasons, layer list, classes |
| `GET /api/districts` | `province` | district names |
| `GET /api/boundary` | `province, district` | simplified GeoJSON outline |
| `GET /api/tiles` | `layer, province, district, year, season, crop` | map tile URL, legend info |
| `GET /api/stats` | `province, district, year, season` | cropland area, class areas, mean indices |
| `GET /api/series` | same | NDVI, EVI, VCI, rainfall per season since 2001 |
| `GET /api/rainfall` | `province, district, year` | monthly rainfall vs normal |
| `GET /api/insights` | `province, district, year, season` | risk level, alerts |
| `GET /api/sources` | - | latest image date per source |
| `POST /api/login` | `username, password` | token (when auth is enabled) |

## Customise

- **Add a map layer:** add an entry to `LAYERS` and `_vis` in `gee_processor.py`, and an image in `_analysis`. A tab appears automatically.
- **Change the baseline:** `BASE_START` and `BASE_END` in `gee_processor.py` (also in `gee/AgroWatch.js`).
- **Change colours:** variables at the top of `style.css`.
- **Ideas:** flood extent (Sentinel-1), crop type maps, district ranking table, CSV export, alert emails, an AI assistant panel that explains results (needs an LLM API key).

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Cannot reach the backend" | Backend not running, wrong `AGROWATCH_API_BASE`, or CORS origin missing |
| "No district-name column found" | Set `DISTRICT_FIELD` in `.env` to the exact column name |
| Asset not found or access denied | Share the asset with the service account (step 3) |
| Request times out | Pick one district, shorten the wait, raise gunicorn `--timeout` |
| Rainfall looks too low for the newest season | The season is not finished; CHIRPS and MODIS lag a few weeks |
| Blank page | Open http://localhost:5000, not the HTML file directly |
