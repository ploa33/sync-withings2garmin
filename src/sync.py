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

First-run / setup flow:
    If no Withings token exists in state AND no WITHINGS_CODE is provided, the script
    generates the Withings OAuth authorization URL, writes a step-by-step guide to
    $GITHUB_STEP_SUMMARY, emits a ::warning annotation and exits 0 (no failure email).

    When the user re-runs the workflow with a WITHINGS_CODE input, the script exchanges
    it for tokens, saves them to the state branch immediately (before touching Garmin),
    then proceeds with the normal sync.
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
RELAY_URL = os.environ.get("RELAY_URL", "").strip().rstrip("/")
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "") or 30)
SHOW_METRICS = os.environ.get("W2G_SHOW_METRICS", "").lower() in ("true", "1")
DEFAULT_APP_SLUG = "relay-withings2garmin"

# ── OAuth setup inputs ────────────────────────────────────────────────────────
# WITHINGS_CODE: one-shot authorization code from Withings (expires in 30s).
# Only used during initial setup; after first exchange it is replaced by the
# refresh_token persisted in the state branch.
WITHINGS_CODE = os.environ.get("WITHINGS_CODE", "").strip()

# Garmin MFA code (TOTP / email OTP). Only needed on first Garmin login if
# the account has 2FA enabled.
GARMIN_MFA_CODE = os.environ.get("GARMIN_MFA_CODE", "").strip()

# redirect_uri used both to build the authorization URL and during the
# code→token exchange. Defaults to GitHub Pages callback helper, with localhost:8080
# as an automatic fallback.
PAGES_REDIRECT_URI = "https://ploa33.github.io/sync-withings2garmin/"
LOCALHOST_REDIRECT_URI = "http://localhost:8080"
OAUTH_REDIRECT_URI = os.environ.get("WITHINGS_REDIRECT_URI", "").strip() or PAGES_REDIRECT_URI


def get_github_oidc_token(audience: str = "withings-sync-relay") -> str | None:
    """Request a GitHub Actions OIDC ID token if available (requires permissions: id-token: write)."""
    request_url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
    request_token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not request_url or not request_token:
        return None
    try:
        resp = requests.get(
            request_url,
            headers={"Authorization": f"Bearer {request_token}"},
            params={"audience": audience},
            timeout=10,
        )
        if resp.status_code == 200:
            token = resp.json().get("value")
            mask_secret(token)
            return token
    except (requests.RequestException, ValueError) as exc:
        print(f"ℹ️ Could not obtain GitHub OIDC token: {exc}")
    return None


def relay_register(relay_url: str, withings_userid: str = "") -> dict | None:
    """Call the relay's POST /register endpoint with GitHub Actions OIDC authentication.

    At Run 1 (withings_userid=""): returns signed OAuth state + GitHub App installation status.
    At Run 2 (withings_userid="12345"): returns signed webhook URL for Withings real-time sync.
    Returns None on any error (graceful fallback to classic mode).
    """
    if not relay_url:
        return None
    oidc_token = get_github_oidc_token()
    if not oidc_token:
        return None
    try:
        payload = {}
        if withings_userid:
            payload["withings_userid"] = str(withings_userid)
        resp = requests.post(
            f"{relay_url}/register",
            headers={
                "Authorization": f"Bearer {oidc_token}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=10,
        )
        if resp.status_code == 200:
            return resp.json()
        print(f"ℹ️ Relay registration returned HTTP {resp.status_code}")
    except (requests.RequestException, ValueError) as exc:
        print(f"ℹ️ Relay registration skipped: {exc}")
    return None


def extract_withings_code(raw: str) -> str:
    """Extract authorization code from either a raw code string or a full redirect URL."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    if "code=" in raw or raw.startswith(("http://", "https://")):
        import urllib.parse
        try:
            parsed = urllib.parse.urlparse(raw)
            qs = urllib.parse.parse_qs(parsed.query)
            if "code" in qs and qs["code"]:
                return qs["code"][0].strip()
        except (ValueError, KeyError, AttributeError):
            return raw
    return raw

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

def mask_token(val: str | None) -> None:
    """Mask sensitive value from GitHub Actions logs."""
    if val:
        print(f"::add-mask::{val}")


mask_secret = mask_token
gh_mask = mask_token


def gh_warning(message: str) -> None:
    if os.environ.get("GITHUB_ACTIONS"):
        print(f"::warning title=Setup Required::{message}")
    else:
        print(f"⚠️  {message}")


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

def load_withings_tokens() -> dict | None:
    """
    Load Withings tokens. Returns None when no token is available yet.

    Priority:
      1. tokens.json in the state directory (persisted by a previous run).
      2. WITHINGS_REFRESH_TOKEN environment variable / secret (legacy fallback).
    """
    if TOKENS_FILE.exists():
        try:
            tokens = json.loads(TOKENS_FILE.read_text())
            if tokens.get("refresh_token"):
                mask_secret(tokens.get("access_token"))
                mask_secret(tokens.get("refresh_token"))
                print("📂 Loaded Withings tokens from state")
                return tokens
        except (OSError, ValueError):
            print("⚠️ Ignoring unreadable tokens.json")

    refresh_token = os.environ.get("WITHINGS_REFRESH_TOKEN", "").strip()
    if refresh_token:
        mask_secret(refresh_token)
        print("🔑 Loaded Withings refresh token from secret (legacy / first run)")
        return {"refresh_token": refresh_token}

    return None  # First run — no token available yet


def _percent_encode_raw(s: str) -> str:
    """Percent-encode every character of a string.

    Prevents GitHub Actions secret scrubbing from matching and masking strings
    registered as secrets (e.g. WITHINGS_CLIENT_ID or WEBHOOK_URL) with '***'
    in $GITHUB_STEP_SUMMARY. Standard web browsers and Withings' OAuth servers
    automatically decode percent-encoded query parameters.
    """
    return "".join(f"%{ord(c):02x}" for c in s)


def build_withings_auth_url(
    client_id: str,
    redirect_uri: str | None = None,
    state: str = "init",
) -> str:
    """Build the Withings OAuth2 authorization URL with percent-encoded params to prevent secret scrubbing."""
    target_redirect = redirect_uri or OAUTH_REDIRECT_URI
    cid_encoded = _percent_encode_raw(client_id)
    redirect_encoded = _percent_encode_raw(target_redirect)
    state_encoded = _percent_encode_raw(state)
    return (
        "https://account.withings.com/oauth2_user/authorize2?"
        f"response_type=code&client_id={cid_encoded}&state={state_encoded}&scope=user.metrics%2Cuser.info&redirect_uri={redirect_encoded}"
    )


def exchange_withings_code(client_id: str, client_secret: str, code: str) -> dict:
    """
    Exchange a one-shot authorization code for an access + refresh token pair.
    The code expires in ~30s — this is called as early as possible in main().
    """
    mask_token(code)
    print("🔄 Exchanging Withings authorization code for tokens…")
    relay_oauth_uri = f"{RELAY_URL}/oauth" if RELAY_URL else ""
    explicit_uri = os.environ.get("WITHINGS_REDIRECT_URI", "").strip()
    primary_uri = explicit_uri or relay_oauth_uri or OAUTH_REDIRECT_URI

    resp = requests.post(
        f"{WITHINGS_API}/v2/oauth2",
        data={
            "action":        "requesttoken",
            "grant_type":    "authorization_code",
            "client_id":     client_id,
            "client_secret": client_secret,
            "code":          code,
            "redirect_uri":  primary_uri,
        },
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()

    # If primary redirect_uri failed, try fallbacks
    if body.get("status") != 0:
        candidates = [relay_oauth_uri, OAUTH_REDIRECT_URI, PAGES_REDIRECT_URI, LOCALHOST_REDIRECT_URI, WEBHOOK_URL]
        fallbacks = [uri for uri in candidates if uri and uri != primary_uri]
        for fb_uri in fallbacks:
            if body.get("status") == 0:
                break
            resp_fb = requests.post(
                f"{WITHINGS_API}/v2/oauth2",
                data={
                    "action":        "requesttoken",
                    "grant_type":    "authorization_code",
                    "client_id":     client_id,
                    "client_secret": client_secret,
                    "code":          code,
                    "redirect_uri":  fb_uri,
                },
                timeout=30,
            )
            if resp_fb.status_code == 200 and resp_fb.json().get("status") == 0:
                body = resp_fb.json()
                break

    if body.get("status") != 0:
        die(
            f"Withings code exchange failed (status={body.get('status')}): {body.get('error', body)}. "
            "Check that your Withings app Callback URL matches exactly."
        )
    print("✅ Withings authorization code exchanged successfully")
    token_body = body["body"]
    mask_secret(token_body.get("access_token"))
    mask_secret(token_body.get("refresh_token"))
    return token_body


def show_setup_guide(client_id: str, relay_info: dict | None = None) -> None:
    """
    Emit a ::warning annotation and write a minimalist step-by-step guide to
    $GITHUB_STEP_SUMMARY with dynamic links to the user's repository.
    """
    auth_url_pages = build_withings_auth_url(client_id, PAGES_REDIRECT_URI)
    auth_url_localhost = build_withings_auth_url(client_id, LOCALHOST_REDIRECT_URI)

    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip("/")
    workflow_url = f"{server}/{repo}/actions/workflows/sync.yml" if repo else ""
    workflow_link = (
        f"[Open 'Run workflow']({workflow_url})"
        if workflow_url
        else "Go to **Actions → Withings → Garmin Sync → Run workflow**"
    )

    gh_warning("No Withings token found. Open the Job Summary below to authorize in 1 click.")

    if relay_info and relay_info.get("state") and RELAY_URL:
        relay_redirect = f"{RELAY_URL}/oauth"
        auth_url_relay = build_withings_auth_url(client_id, relay_redirect, state=relay_info["state"])
        installed = relay_info.get("installed", False)
        app_slug = relay_info.get("app_slug", DEFAULT_APP_SLUG)
        install_url = f"https://github.com/apps/{app_slug}/installations/new"
        withings_dash = "https://developer.withings.com/dashboard/"

        if installed:
            guide = f"""### ⚡ One-Click Withings Setup

✅ **Garmin Connect:** Ready · ✅ **GitHub App:** Installed on `{repo or 'your repo'}`

👉 **[Authorize Withings Account]({auth_url_relay})**

*Approve access on Withings — your first sync and real-time webhook will start automatically.*

> 💡 **Got `redirect_uri_mismatch`?** Set your [Withings App]({withings_dash}) Callback URL to:
> `{relay_redirect}`
"""
        else:
            guide = f"""### ⚡ Setup Required (2 Clicks)

✅ **Garmin Connect:** Ready

1. **[Install the GitHub App]({install_url})** on `{repo or 'your repo'}` *(Only select repositories)*.
2. **[Authorize Withings Account]({auth_url_relay})**

*Once approved, your first sync and real-time webhook start automatically.*

> 💡 **Got `redirect_uri_mismatch`?** Set your [Withings App]({withings_dash}) Callback URL to:
> `{relay_redirect}`
"""

    else:
        guide = f"""### ⚙️ Withings → Garmin — Initial Setup Required

No Withings token was found. Complete this one-time setup:

1. Keep {workflow_link} open in a tab.
2. **[👉 Authorize Withings Account]({auth_url_pages})** *(or [via localhost]({auth_url_localhost}))*
3. Copy the code (valid ~30s), paste it into **`withings_code`**, and click **Run workflow**.
"""
    gh_summary(guide)
    print("\n" + "=" * 60)
    print("  ⚙️  SETUP REQUIRED — see the Job Summary tab")
    print("=" * 60 + "\n")



def refresh_withings_token(
    client_id: str,
    client_secret: str,
    refresh_token: str,
    max_retries: int = 3,
) -> dict:
    """Exchange a refresh_token for a new access_token + refresh_token pair (retries on 601)."""
    mask_token(refresh_token)
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
            token_body = body["body"]
            mask_secret(token_body.get("access_token"))
            mask_secret(token_body.get("refresh_token"))
            print("🔄 Withings access token refreshed successfully")
            return token_body

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
    mask_secret(token_data.get("access_token"))
    mask_secret(token_data.get("refresh_token"))

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


def _webhook_warning(message: str) -> None:
    """Visible (non-fatal) annotation: real-time sync is broken but scheduled sync still works."""
    if os.environ.get("GITHUB_ACTIONS"):
        print(f"::warning title=Real-time webhook::{message}")
    else:
        print(f"⚠️  {message}")


def ensure_withings_webhook(access_token: str, userid: str = "") -> None:
    """Subscribe the Withings Notify API to the real-time webhook proxy (if configured).

    The existing subscription is checked first (action=list) so that Withings does not
    re-validate the callback URL on every run. Withings status codes:
      0   = OK
      293 = callback URL absent or incorrect (failed the HEAD validation) → ERROR
    """
    target_webhook = WEBHOOK_URL
    if not target_webhook and RELAY_URL and userid:
        relay_data = relay_register(RELAY_URL, withings_userid=userid)
        if relay_data and relay_data.get("webhook_url"):
            target_webhook = relay_data["webhook_url"]
            print("📡 Obtained signed real-time webhook URL from relay")

    if not target_webhook:
        return
    headers = {"Authorization": f"Bearer {access_token}"}
    try:
        resp = requests.post(
            f"{WITHINGS_API}/notify",
            data={"action": "list", "appli": 1},
            headers=headers,
            timeout=10,
        )
        data = resp.json()
        if data.get("status") == 0:
            profiles = (data.get("body") or {}).get("profiles") or []
            if any(p.get("callbackurl") == target_webhook for p in profiles):
                print("📡 Withings real-time webhook active")
                return

        resp = requests.post(
            f"{WITHINGS_API}/notify",
            data={"action": "subscribe", "callbackurl": target_webhook, "appli": 1},
            headers=headers,
            timeout=10,
        )
        data = resp.json()
        status = data.get("status")
        if status == 0:
            print("📡 Withings real-time webhook subscribed")
        elif status == 293:
            _webhook_warning(
                "Withings rejected callback URL (status 293: callback URL absent or incorrect). "
                "The URL must be public HTTPS and answer HTTP 2xx to a HEAD/GET request. "
                "Real-time sync is OFF — scheduled runs still work."
            )
        else:
            _webhook_warning(
                f"Withings webhook subscription failed (status={status}: {data.get('error', '')}). "
                "Real-time sync is OFF — scheduled runs still work."
            )
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
    """Return an authenticated Garmin client using the persisted session.

    If Garmin Connect requires 2-factor authentication (MFA):
      - Returns GARMIN_MFA_CODE if provided by the user.
      - If missing/empty, outputs a clear GitHub Actions error annotation and
        exits with instructions to fill the 'garmin_mfa_code' input.
    """
    import garminconnect  # imported lazily so dry-run / tests don't need it

    def _handle_mfa() -> str:
        if not GARMIN_MFA_CODE:
            server = os.environ.get("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
            repo = os.environ.get("GITHUB_REPOSITORY", "").strip("/")
            wf_url = f"{server}/{repo}/actions/workflows/sync.yml" if repo else ""
            wf_link = f"👉 **[Open 'Run workflow']({wf_url})**" if wf_url else "Go to **Actions → Run workflow**"
            gh_summary(
                "### 🔐 Garmin 2FA Verification Required\n\n"
                f"{wf_link} and enter your current 6-digit verification code in **`garmin_mfa_code`**.\n"
                "*(Only needed once — your session will be saved automatically.)*\n"
            )
            msg = "Garmin 2FA is active. Re-run this workflow and enter your verification code in 'garmin_mfa_code'."
            print(f"::error title=Garmin MFA Required::{msg}")
            sys.exit(1)
        print("🔐 Using provided Garmin MFA code (TOTP/OTP)")
        return GARMIN_MFA_CODE

    garmin = garminconnect.Garmin(email, password, prompt_mfa=_handle_mfa)
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


def describe(measure_dt: datetime, payload: dict, show_values: bool = SHOW_METRICS) -> list[str]:
    """Human-readable cells: date, weight, fat, muscle, water, bone.

    Biometric values are masked by default to protect health privacy in GitHub Actions logs.
    Set W2G_SHOW_METRICS=true to reveal raw values.
    """
    cells = [measure_dt.strftime("%Y-%m-%d %H:%M UTC")]
    for key, unit in PAYLOAD_COLUMNS:
        val = payload.get(key)
        if val is None:
            cells.append("--")
        elif show_values:
            cells.append(f"{val} {unit}")
        else:
            cells.append("✓ recorded")
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
        server = os.environ.get("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
        repo = os.environ.get("GITHUB_REPOSITORY", "").strip("/")
        secrets_url = f"{server}/{repo}/settings/secrets/actions" if repo else ""
        secrets_link = (
            f"[👉 Click here to configure your secrets]({secrets_url})"
            if secrets_url
            else "Go to **Settings → Secrets and variables → Actions**"
        )
        rows = [f"| `{n}` | {'✅ Configured' if env[n] else '❌ **Missing**'} |" for n in required]
        summary_table = (
            "### ❌ Configuration Error — Missing Secrets\n\n"
            "Some required repository secrets are not configured or empty:\n\n"
            "| Secret | Status |\n|---|---|\n"
            + "\n".join(rows)
            + f"\n\n{secrets_link}\n"
        )
        gh_summary(summary_table)
        die(f"Missing required secrets: {', '.join(missing)}")

    code = extract_withings_code(WITHINGS_CODE)
    if code:
        mask_secret(code)
    if GARMIN_MFA_CODE:
        mask_secret(GARMIN_MFA_CODE)

    # ── Step 0 — First-run setup: exchange WITHINGS_CODE immediately ──────────
    # The Withings authorization code expires in ~30 seconds. Exchange it as the
    # very first API call — before loading state, before touching Garmin — to
    # maximise the chance of beating the expiry window.
    if code:
        print("\n── Step 0 / 4 : Exchange Withings authorization code ──")
        print("⏱  Code expires in ~30s — exchanging immediately…")
        token_data = exchange_withings_code(
            env["WITHINGS_CLIENT_ID"], env["WITHINGS_CLIENT_SECRET"], code
        )
        # Persist tokens immediately, before touching Garmin.
        # If Garmin fails (e.g. MFA required), the Withings token is already safe.
        save_withings_tokens(token_data)
        print("✅ Withings tokens saved to state (Withings setup complete)")

    # ── Step 1 — Withings OAuth2 ──────────────────────────────────────────────
    print("\n── Step 1 / 4 : Withings OAuth2 token ──")
    tokens = load_withings_tokens()

    if tokens is None:
        # Pre-flight check: validate Garmin credentials early so the user catches
        # typos or MFA requirements before attempting the Withings authorization.
        if mode != "dry-run":
            print("\n── Pre-flight check: Garmin Connect authentication ──")
            get_garmin_client(env["GARMIN_EMAIL"], env["GARMIN_PASSWORD"])

        # Attempt to register with the relay using GitHub Actions OIDC (Run 1)
        relay_info = relay_register(RELAY_URL) if RELAY_URL else None

        show_setup_guide(env["WITHINGS_CLIENT_ID"], relay_info=relay_info)
        gh_output("synced-count", 0)
        sys.exit(0)

    access_token = get_withings_access_token(env["WITHINGS_CLIENT_ID"], env["WITHINGS_CLIENT_SECRET"])
    tokens = load_withings_tokens() or {}
    userid = str(tokens.get("userid", ""))
    ensure_withings_webhook(access_token, userid=userid)

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
    if GARMIN_MFA_CODE:
        print("🔐 Garmin MFA code provided via workflow input")
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
