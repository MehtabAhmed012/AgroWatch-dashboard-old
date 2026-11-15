"""Flask API for the AgroWatch dashboard.

Run locally:  python app.py
Production:   gunicorn app:app --bind 0.0.0.0:$PORT --timeout 300
"""
import logging
import os
from datetime import date

import ee
from dotenv import load_dotenv

load_dotenv()  # must run before importing modules that read env vars

from flask import Flask, jsonify, request, send_from_directory  # noqa: E402
from flask_cors import CORS  # noqa: E402
from werkzeug.exceptions import HTTPException  # noqa: E402

import authentication as auth  # noqa: E402
import gee_processor as gee  # noqa: E402

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("agrowatch")

FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))
# The API also serves the dashboard, so `python app.py` + http://localhost:5000 is all you need.
app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
CORS(app, origins=origins)

auth.check_auth_config()
auth.init_earth_engine()


def _args():
    """Validate the shared filters: province, district, year, season, crop."""
    today = date.today()
    season = (request.args.get("season") or "kharif").lower()
    if season not in gee.SEASONS:
        raise ValueError(f"Unknown season '{season}'. Options: {', '.join(gee.SEASONS)}")
    try:
        year = int(request.args.get("year", today.year - 1))
    except ValueError:
        raise ValueError("'year' must be a number like 2025")
    if not gee.FIRST_YEAR <= year <= today.year:
        raise ValueError(f"'year' must be between {gee.FIRST_YEAR} and {today.year}")

    provinces = gee.list_provinces()
    province = request.args.get("province") or None
    if not provinces:
        province = None
    elif province and province not in provinces:
        raise ValueError(f"Unknown province '{province}'")

    district = request.args.get("district") or None
    if district and district not in gee.list_districts(province):
        raise ValueError(f"Unknown district '{district}'")
    crop = request.args.get("crop", "1") != "0"
    return province, district, year, season, crop


# ------------------------------------------------------------------- routes
@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/api/health")
def health():
    return jsonify(status="ok")


@app.post("/api/login")
def login():
    body = request.get_json(silent=True) or {}
    if not auth.AUTH_ENABLED:
        return jsonify(token="auth-disabled")
    if auth.verify_credentials(body.get("username"), body.get("password")):
        return jsonify(token=auth.create_token(body["username"]))
    return jsonify(error="Invalid credentials"), 401


@app.get("/api/meta")
@auth.token_required
def meta():
    today = date.today()
    return jsonify(
        provinces=gee.list_provinces(),
        default_province=os.getenv("DEFAULT_PROVINCE", "Punjab"),
        years=list(range(gee.FIRST_YEAR, today.year + 1)),
        default_year=today.year - 1,
        seasons=[{"id": k, "label": v["label"]} for k, v in gee.SEASONS.items()],
        base=[gee.BASE_START, gee.BASE_END],
        **gee.layer_meta(),
    )


@app.get("/api/districts")
@auth.token_required
def districts():
    province = request.args.get("province") or None
    if not gee.list_provinces():
        province = None
    return jsonify(districts=gee.list_districts(province))


@app.get("/api/boundary")
@auth.token_required
def boundary():
    province, district, *_ = _args()
    return jsonify(gee.get_boundary(province, district))


@app.get("/api/tiles")
@auth.token_required
def tiles():
    layer = request.args.get("layer", "stress")
    if layer not in gee.LAYERS:
        raise ValueError(f"Unknown layer '{layer}'. Options: {', '.join(gee.LAYERS)}")
    province, district, year, season, crop = _args()
    return jsonify(gee.get_tiles(layer, province, district, year, season, crop))


@app.get("/api/stats")
@auth.token_required
def stats():
    province, district, year, season, _ = _args()
    return jsonify(gee.get_stats(province, district, year, season))


@app.get("/api/series")
@auth.token_required
def series():
    province, district, year, season, _ = _args()
    return jsonify(gee.get_series(province, district, year, season))


@app.get("/api/rainfall")
@auth.token_required
def rainfall():
    province, district, year, _, _ = _args()
    return jsonify(gee.get_rain_monthly(province, district, year))


@app.get("/api/insights")
@auth.token_required
def insights():
    province, district, year, season, _ = _args()
    return jsonify(gee.build_insights(
        gee.get_stats(province, district, year, season),
        gee.get_series(province, district, year, season),
    ))


@app.get("/api/sources")
@auth.token_required
def sources():
    return jsonify(sources=gee.get_sources())


# ------------------------------------------------------------------- errors
@app.errorhandler(ValueError)
def bad_request(e):
    return jsonify(error=str(e)), 400


@app.errorhandler(ee.EEException)
def earth_engine_error(e):
    log.error("Earth Engine error: %s", e)
    return jsonify(error="Earth Engine: " + str(e)[:300]), 502


@app.errorhandler(RuntimeError)
def config_error(e):
    log.error("Configuration error: %s", e)
    return jsonify(error=str(e)), 500


@app.errorhandler(HTTPException)
def http_error(e):
    return jsonify(error=e.description), e.code


@app.errorhandler(Exception)
def server_error(e):
    log.exception("Unhandled error")
    return jsonify(error=str(e) if app.debug else "Server error. Check the backend logs."), 500


def start_ngrok(port):
    """Optional: give this server a public https address (set USE_NGROK=true in .env)."""
    from pyngrok import ngrok  # downloads the ngrok program automatically on first use

    token = os.getenv("NGROK_AUTHTOKEN")
    if token:
        ngrok.set_auth_token(token)
    domain = os.getenv("NGROK_DOMAIN") or None
    tunnel = ngrok.connect(port, "http", domain=domain) if domain else ngrok.connect(port, "http")
    url = tunnel.public_url.replace("http://", "https://", 1)
    print("\n" + "=" * 64)
    print(" ngrok public address:", url)
    print(" Put it in frontend/index.html as window.AGROWATCH_API_BASE")
    print(" and add your website to ALLOWED_ORIGINS in .env")
    print("=" * 64 + "\n")
    return url


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    debug = os.getenv("FLASK_DEBUG") == "1"
    use_ngrok = os.getenv("USE_NGROK", "false").lower() == "true"
    if use_ngrok:
        start_ngrok(port)
    # The auto-reloader would start a second tunnel, so it is off when ngrok is on.
    app.run(host="0.0.0.0", port=port, debug=debug, use_reloader=debug and not use_ngrok)
    # updated