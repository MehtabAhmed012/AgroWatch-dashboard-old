"""Authentication helpers.

Two separate concerns live here:
1. init_earth_engine()  -> how THIS SERVER talks to Google Earth Engine.
2. token_required / create_token -> how DASHBOARD USERS talk to THIS SERVER (optional).
"""
import os
import time
from functools import wraps

import ee
import jwt
from flask import jsonify, request
from werkzeug.security import check_password_hash

AUTH_ENABLED = os.getenv("AUTH_ENABLED", "false").lower() == "true"
JWT_SECRET = os.getenv("JWT_SECRET", "change-me-to-a-long-random-string")
TOKEN_TTL_SECONDS = 8 * 3600


# ---------------------------------------------------------------- Earth Engine
def init_earth_engine():
    """Initialise Earth Engine with a service account, or local user credentials."""
    project = os.getenv("GEE_PROJECT") or None
    account = os.getenv("GEE_SERVICE_ACCOUNT")
    key_file = os.getenv("GEE_PRIVATE_KEY_FILE")
    key_json = os.getenv("GEE_PRIVATE_KEY_JSON")

    if account and key_json:
        creds = ee.ServiceAccountCredentials(account, key_data=key_json)
        ee.Initialize(credentials=creds, project=project)
    elif account and key_file:
        creds = ee.ServiceAccountCredentials(account, key_file)
        ee.Initialize(credentials=creds, project=project)
    else:
        # Uses the credentials saved by `earthengine authenticate`
        ee.Initialize(project=project)


# ------------------------------------------------------------ Dashboard users
def check_auth_config():
    if AUTH_ENABLED and JWT_SECRET == "change-me-to-a-long-random-string":
        raise RuntimeError("AUTH_ENABLED=true but JWT_SECRET is still the default. Set a real secret.")


def verify_credentials(username, password):
    expected_user = os.getenv("DASH_USER", "admin")
    pass_hash = os.getenv("DASH_PASS_HASH", "")
    if not pass_hash:
        return False
    return username == expected_user and check_password_hash(pass_hash, password or "")


def create_token(username):
    payload = {"sub": username, "exp": int(time.time()) + TOKEN_TTL_SECONDS}
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def token_required(fn):
    """Protect a route. No-op when AUTH_ENABLED=false."""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not AUTH_ENABLED:
            return fn(*args, **kwargs)
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return jsonify(error="Missing token"), 401
        try:
            jwt.decode(header[7:], JWT_SECRET, algorithms=["HS256"])
        except jwt.PyJWTError:
            return jsonify(error="Invalid or expired token"), 401
        return fn(*args, **kwargs)

    return wrapper
