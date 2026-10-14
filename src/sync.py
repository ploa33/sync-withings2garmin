#!/usr/bin/env python3
"""
Withings smart scales (Body, Body+, Body Smart, Body Scan, Body Comp, Body Cardio)
→ Garmin Connect sync.

Designed to run inside the `ploa33/sync-withings2garmin` GitHub Action, but also
works locally. All persistent state lives in a single directory (W2G_STATE_DIR):

    tokens.json          Withings OAuth tokens (refresh token rotates on every refresh)
    garth_session/       Garmin SSO session (avoids full logins / Cloudflare challenges)
    sync_state.json      Timestamp of the last weigh-in uploaded (prevents duplicates)

Modes (W2G_MODE or CLI flag):
    sync      Fetch new Withings weigh-ins and upload them to Garmin (default)
    dry-run   Fetch and display weigh-ins, upload nothing        (--dry-run)
    simulate  Upload one FAKE weigh-in to Garmin to test the chain (--simulate)
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

# ── Configuration ─────────────────────────────────────────────────────────────

WITHINGS_API = "https://wbsapi.withings.net"

STATE_DIR = Path(os.environ.get("W2G_STATE_DIR", ".")).resolve()
TOKENS_FILE = STATE_DIR / "tokens.json"
GARTH_SESSION_DIR = STATE_DIR / "garth_session"
SYNC_STATE_FILE = STATE_DIR / "sync_state.json"

WEBHOOK_URL = os.environ.get("WEBHOOK_URL", "").strip()
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "") or 30)

# Groups closer than this (seconds) belong to the same weigh-in (weight + impedance).
SESSION_MERGE_WINDOW = 300

# Withings measure type IDs → friendly names
MEASURE_TYPES = {
    1:  "weight",          # kg
    5:  "fat_free_mass",   # kg
    6:  "fat_percent",     # % (Withings already returns a percentage)
    8:  "fat_mass_weight", # kg
    76: "muscle_mass",     # kg
    77: "hydration",       # kg  → converted to % before Garmin upload
    88: "bone_mass",       # kg
}

VALID_MODES = ("sync", "dry-run", "simulate")


# ── GitHub Actions helpers (no-ops when run locally) ─────────────────────────

def gh_output(name: str, value: object) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"{name}={value}\n")


def gh_summary(markdown: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(markdown + "\n")


def die(message: str) -> None:
    print(f"❌ {message}")
    if os.environ.get("GITHUB_ACTIONS"):
        print(f"::error title=withings2garmin::{message}")
    sys.exit(1)


# ── Withings OAuth2 ───────────────────────────────────────────────────────────

def load_withings_tokens() -> dict:
    """
    Load Withings tokens.
    Priority:
      1. tokens.json in the state directory (persisted by a previous run).
      2. WITHINGS_REFRESH_TOKEN environment variable / secret (first run).
    """
    if TOKENS_FILE.exists():
        try:
            tokens = json.loads(TOKENS_FILE.read_text())
            if tokens.get("refresh_token"):
                print("📂 Loaded Withings tokens from state")
                return tokens
        except (OSError, ValueError):
            print("⚠️ Ignoring unreadable tokens.json")

    refresh_token = os.environ.get("WITHINGS_REFRESH_TOKEN", "").strip()
    if not refresh_token:
        die("No Withings refresh token found. Set the WITHINGS_REFRESH_TOKEN secret.")

    print("🔑 Loaded Withings refresh token from secret (first run)")
    return {"refresh_token": refresh_token}


def refresh_withings_token(
    client_id: str,
    client_secret: str,
    refresh_token: str,
    max_retries: int = 3,
) -> dict:
    """Exchange a refresh_token for a new access_token + refresh_token pair (retries on 601)."""
    for attempt in range(max_retries + 1):
        resp = requests.post(
            f"{WITHINGS_API}/v2/oauth2",
            data={
                "action":        "requesttoken",
                "grant_type":    "refresh_token",
                "client_id":     client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
            },
            timeout=30,
        )
        resp.raise_for_status()
        body = resp.json()
        status = body.get("status")

        if status == 0:
            print("🔄 Withings access token refreshed successfully")
            return body["body"]

        # 601: Same arguments in less than 10 seconds (consecutive webhook calls)
        if status == 601 and attempt < max_retries:
            wait_sec = 12
            print(f"⏳ Withings rate limit (status=601). Waiting {wait_sec}s "
                  f"(attempt {attempt + 1}/{max_retries})...")
            time.sleep(wait_sec)
            continue

        die(f"Withings token refresh failed (status={status}): {body.get('error', body)}. "
            "If the refresh token expired, generate a new one and update WITHINGS_REFRESH_TOKEN, "
            "then delete the state branch.")
    raise AssertionError("unreachable")


def save_withings_tokens(token_data: dict) -> None:
    """Persist the refreshed Withings tokens and expiry timestamp to the state directory."""
    now_ts = int(time.time())
    expires_in = int(token_data.get("expires_in", 10800))
    expires_at = token_data.get("expires_at", now_ts + expires_in)

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    TOKENS_FILE.write_text(
        json.dumps(
            {
                "access_token":  token_data["access_token"],
                "refresh_token": token_data["refresh_token"],
                "userid":        token_data.get("userid", ""),
                "expires_at":    expires_at,
            },
            indent=2,
        )
    )
    print("💾 Withings tokens saved to state")


def get_withings_access_token(client_id: str, client_secret: str) -> str:
    """Return a valid access token, refreshing (and persisting) it when needed."""
    tokens = load_withings_tokens()
    access_token = tokens.get("access_token")
    expires_at = int(tokens.get("expires_at", 0) or 0)
    now_ts = int(time.time())

    # Reuse the cached access token if it is valid for at least 10 more minutes
    if access_token and expires_at > now_ts + 600:
        print(f"🔑 Using cached Withings access token (expires in {(expires_at - now_ts) // 60} min)")
        return access_token

    token_data = refresh_withings_token(client_id, client_secret, tokens["refresh_token"])
    save_withings_tokens(token_data)
    return token_data["access_token"]


def ensure_withings_webhook(access_token: str) -> None:
    """Subscribe the Withings Notify API to the real-time webhook proxy (if configured)."""
    if not WEBHOOK_URL:
        return
    try:
        resp = requests.post(
            f"{WITHINGS_API}/notify",
            data={"action": "subscribe", "callbackurl": WEBHOOK_URL, "appli": 1},
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
        data = resp.json()
        if data.get("status") in (0, 293):
            print("📡 Withings real-time webhook active")
        else:
            print(f"ℹ️ Withings webhook status: {data.get('status')} ({data.get('error', '')})")
    except (requests.RequestException, ValueError) as exc:
        print(f"⚠️ Webhook subscription check skipped: {exc}")


# ── Withings measures ─────────────────────────────────────────────────────────

def decode_value(value: int, unit: int) -> float:
    """Decode a Withings raw measure: real_value = value × 10^unit."""
    return value * (10 ** unit)


def fetch_withings_measures(access_token: str, startdate: int) -> list[dict]:
    """Fetch body-composition measurement groups recorded since `startdate` (unix ts)."""
    resp = requests.get(
        f"{WITHINGS_API}/measure",
        params={
            "action":    "getmeas",
            "startdate": startdate,
            "category":  1,   # 1 = real measures (not goals)
        },
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()

    if body.get("status") != 0:
        die(f"Withings /measure API error (status={body.get('status')}): {body.get('error', body)}")

    groups = body["body"].get("measuregrps", [])
    print(f"📊 Found {len(groups)} measurement group(s)")
    return groups


def parse_measure_group(group: dict) -> dict:
    """Parse a Withings measure group dict into named float values."""
    result: dict[str, float] = {}
    for measure in group.get("measures", []):
        key = MEASURE_TYPES.get(measure["type"])
        if key:
            result[key] = round(decode_value(measure["value"], measure["unit"]), 4)
    return result


def group_measurements(groups: list[dict]) -> list[tuple[datetime, dict]]:
    """
    Cluster Withings measure groups into distinct weigh-in sessions.
    Groups within SESSION_MERGE_WINDOW seconds are merged (e.g., weight + impedance).
    Returns list of (datetime, measures_dict) sorted chronologically (oldest first).
    """
    sorted_groups = sorted(groups, key=lambda g: g["date"])
    events: list[dict] = []

    for g in sorted_groups:
        parsed = parse_measure_group(g)
        if not parsed:
            continue
        g_date = g["date"]

        if events and abs(g_date - events[-1]["date"]) <= SESSION_MERGE_WINDOW:
            events[-1]["measures"].update(parsed)
        else:
            events.append({"date": g_date, "measures": parsed})

    return [
        (datetime.fromtimestamp(ev["date"], tz=timezone.utc), ev["measures"])
        for ev in events
        if ev["measures"].get("weight")
    ]


def to_garmin_payload(measures: dict) -> dict:
    """Convert Withings measures into Garmin `add_body_composition` keyword arguments."""
    weight = measures.get("weight")
    fat_percent = measures.get("fat_percent")
    fat_mass_kg = measures.get("fat_mass_weight")
    fat_free_kg = measures.get("fat_free_mass")
    hydration_kg = measures.get("hydration")

    # Fallback calculation for fat % if not returned directly by type 6
    if fat_percent is None and weight:
        if fat_mass_kg is not None:
            fat_percent = round(fat_mass_kg / weight * 100, 2)
        elif fat_free_kg is not None:
            fat_percent = round((weight - fat_free_kg) / weight * 100, 2)

    # Withings returns hydration in kg; Garmin expects a percentage
    hydration_percent = None
    if hydration_kg is not None and weight:
        hydration_percent = round(hydration_kg / weight * 100, 2)

    return {
        "weight":            weight,
        "percent_fat":       fat_percent,
        "percent_hydration": hydration_percent,
        "bone_mass":         measures.get("bone_mass"),
        "muscle_mass":       measures.get("muscle_mass"),
    }


# ── Sync state (de-duplication) ───────────────────────────────────────────────

def load_last_synced_ts() -> int:
    try:
        return int(json.loads(SYNC_STATE_FILE.read_text()).get("last_synced_ts", 0))
    except (OSError, ValueError):
        return 0


def save_last_synced_ts(ts: int) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    SYNC_STATE_FILE.write_text(json.dumps({"last_synced_ts": ts}, indent=2))


# ── Garmin Connect ────────────────────────────────────────────────────────────

def get_garmin_client(email: str, password: str):
    """Return an authenticated Garmin client using the persisted session."""
    import garminconnect  # imported lazily so dry-run / tests don't need it

    garmin = garminconnect.Garmin(email, password)
    GARTH_SESSION_DIR.mkdir(parents=True, exist_ok=True)
    garmin.login(tokenstore=str(GARTH_SESSION_DIR))
    print("✅ Garmin login successful")
    return garmin


PAYLOAD_COLUMNS = (
    ("weight", "kg"),
    ("percent_fat", "%"),
    ("muscle_mass", "kg"),
    ("percent_hydration", "%"),
    ("bone_mass", "kg"),
)


def describe(measure_dt: datetime, payload: dict) -> list[str]:
    """Human-readable cells: date, weight, fat, muscle, water, bone."""
    cells = [measure_dt.strftime("%Y-%m-%d %H:%M UTC")]
    for key, unit in PAYLOAD_COLUMNS:
        cells.append("--" if payload[key] is None else f"{payload[key]} {unit}")
    return cells


# ── Entry point ───────────────────────────────────────────────────────────────

def parse_args(argv: list[str]) -> tuple[str, int, bool]:
    mode = (os.environ.get("W2G_MODE", "") or "sync").strip().lower()
    if os.environ.get("SIMULATE", "").lower() == "true":  # backward compatibility
        mode = "simulate"
    lookback = LOOKBACK_DAYS
    force = os.environ.get("W2G_FORCE_RESYNC", "").lower() == "true"

    for i, arg in enumerate(argv):
        if arg == "--simulate":
            mode = "simulate"
        elif arg == "--dry-run":
            mode = "dry-run"
        elif arg == "--force":
            force = True
        elif arg in ("--days", "-d") and i + 1 < len(argv):
            lookback = int(argv[i + 1])

    if mode not in VALID_MODES:
        die(f"Invalid mode '{mode}'. Expected one of: {', '.join(VALID_MODES)}")
    return mode, lookback, force


def main() -> None:
    mode, lookback, force = parse_args(sys.argv[1:])

    print("=" * 60)
    print("  Withings → Garmin Connect Sync")
    print(f"  {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}  |  mode: {mode}")
    print("=" * 60)

    names = ("WITHINGS_CLIENT_ID", "WITHINGS_CLIENT_SECRET", "GARMIN_EMAIL", "GARMIN_PASSWORD")
    env = {name: os.environ.get(name, "").strip() for name in names}
    required = names[:2] if mode == "dry-run" else names
    missing = [name for name in required if not env[name]]
    if missing:
        die(f"Missing required secrets: {', '.join(missing)}")

    # ── Step 1 — Withings OAuth2 ──────────────────────────────────────────────
    print("\n── Step 1 / 4 : Withings OAuth2 token ──")
    access_token = get_withings_access_token(env["WITHINGS_CLIENT_ID"], env["WITHINGS_CLIENT_SECRET"])
    ensure_withings_webhook(access_token)

    # ── Step 2 — Weigh-ins to sync ────────────────────────────────────────────
    last_synced_ts = 0 if force else load_last_synced_ts()

    if mode == "simulate":
        print("\n🧪 SIMULATION — a FAKE weigh-in will be uploaded to your Garmin account")
        weigh_ins = [(datetime.now(timezone.utc), {
            "weight": 74.5, "fat_percent": 17.8, "muscle_mass": 36.1,
            "hydration": 41.0, "bone_mass": 3.2,
        })]
    else:
        window_start = int((datetime.now(timezone.utc) - timedelta(days=lookback)).timestamp())
        startdate = max(window_start, last_synced_ts + 1)
        since = datetime.fromtimestamp(startdate, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        print(f"\n── Step 2 / 4 : Fetch Withings measures since {since} ──")
        groups = fetch_withings_measures(access_token, startdate)
        weigh_ins = [w for w in group_measurements(groups) if w[0].timestamp() > last_synced_ts]
        print(f"📈 {len(weigh_ins)} new weigh-in(s) to sync")

    payloads = [(dt, to_garmin_payload(m)) for dt, m in weigh_ins]
    for dt, payload in payloads:
        print("   • " + " | ".join(describe(dt, payload)))

    if not payloads or mode == "dry-run":
        gh_output("synced-count", 0)
        gh_summary(f"### ⚖️ Withings → Garmin\n\nMode `{mode}`: "
                   f"{len(payloads)} weigh-in(s) found, nothing uploaded.")
        print("\nℹ️  Nothing uploaded." + (" (dry-run)" if mode == "dry-run" else ""))
        return

    # ── Step 3 — Garmin authentication ────────────────────────────────────────
    print("\n── Step 3 / 4 : Garmin Connect authentication ──")
    garmin = get_garmin_client(env["GARMIN_EMAIL"], env["GARMIN_PASSWORD"])

    # ── Step 4 — Upload weigh-ins (oldest first, checkpoint after each) ───────
    print(f"\n── Step 4 / 4 : Upload {len(payloads)} weigh-in(s) to Garmin Connect ──")
    rows = []
    for dt, payload in payloads:
        garmin.add_body_composition(timestamp=dt.isoformat(), **payload)
        cells = describe(dt, payload)
        print("   ✅ " + " | ".join(cells))
        rows.append("| " + " | ".join(cells) + " |")
        if mode == "sync":
            save_last_synced_ts(int(dt.timestamp()))

    gh_output("synced-count", len(payloads))
    gh_summary("### ⚖️ Withings → Garmin\n\n"
               f"Mode `{mode}`: **{len(payloads)}** weigh-in(s) uploaded.\n\n"
               "| Date | Weight | Fat | Muscle | Water | Bone |\n|---|---|---|---|---|---|\n"
               + "\n".join(rows))
    print("\n🎉 Sync complete.\n")


if __name__ == "__main__":
    main()
