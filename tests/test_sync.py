import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "sync.py"


@pytest.fixture()
def sync(tmp_path, monkeypatch):
    """Import src/sync.py with an isolated state directory."""
    monkeypatch.setenv("W2G_STATE_DIR", str(tmp_path))
    spec = importlib.util.spec_from_file_location("w2g_sync", SRC)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def grp(ts, *measures):
    return {"date": ts, "measures": [{"type": t, "value": v, "unit": u} for t, v, u in measures]}


def test_decode_value(sync):
    assert sync.decode_value(74512, -3) == pytest.approx(74.512)


def test_groups_within_window_are_merged(sync):
    groups = [
        grp(1000, (1, 74500, -3)),
        grp(1100, (6, 178, -1), (88, 32, -1)),
        grp(9000, (1, 75000, -3)),
    ]
    sessions = sync.group_measurements(groups)
    assert len(sessions) == 2
    dt, m = sessions[0]
    assert dt == datetime.fromtimestamp(1000, tz=timezone.utc)
    assert m == {"weight": 74.5, "fat_percent": 17.8, "bone_mass": 3.2}


def test_sessions_without_weight_are_dropped(sync):
    assert sync.group_measurements([grp(1000, (6, 178, -1))]) == []


def test_payload_conversions(sync):
    payload = sync.to_garmin_payload({
        "weight": 80.0,
        "fat_mass_weight": 16.0,
        "hydration": 44.0,
        "visceral_fat": 4.0,
    })
    assert payload["percent_fat"] == 20.0
    assert payload["percent_hydration"] == 55.0
    assert payload["bone_mass"] is None
    assert payload["visceral_fat_rating"] == 4.0


def test_visceral_fat_measure_type(sync):
    assert sync.MEASURE_TYPES[125] == "visceral_fat"
    groups = [grp(1000, (1, 75000, -3), (125, 5, 0))]
    sessions = sync.group_measurements(groups)
    assert len(sessions) == 1
    assert sessions[0][1]["visceral_fat"] == 5.0
    payload = sync.to_garmin_payload(sessions[0][1])
    assert payload["visceral_fat_rating"] == 5.0


def test_fat_percent_from_fat_free_mass(sync):
    assert sync.to_garmin_payload({"weight": 80.0, "fat_free_mass": 64.0})["percent_fat"] == 20.0


def test_last_synced_roundtrip(sync, tmp_path):
    assert sync.load_last_synced_ts() == 0
    sync.save_last_synced_ts(1234)
    assert sync.load_last_synced_ts() == 1234
    assert json.loads((tmp_path / "sync_state.json").read_text()) == {"last_synced_ts": 1234}


def test_cached_access_token_is_reused(sync, tmp_path, monkeypatch):
    (tmp_path / "tokens.json").write_text(json.dumps(
        {"access_token": "A", "refresh_token": "R", "expires_at": 4_000_000_000}))
    monkeypatch.setattr(sync, "refresh_withings_token", lambda *a, **k: pytest.fail("should not refresh"))
    assert sync.get_withings_access_token("id", "secret") == "A"


def test_expired_token_is_refreshed_and_saved(sync, tmp_path, monkeypatch):
    (tmp_path / "tokens.json").write_text(json.dumps(
        {"access_token": "OLD", "refresh_token": "R1", "expires_at": 0}))
    monkeypatch.setattr(sync, "refresh_withings_token",
                        lambda *a, **k: {"access_token": "NEW", "refresh_token": "R2", "expires_in": 10800})
    assert sync.get_withings_access_token("id", "secret") == "NEW"
    assert json.loads((tmp_path / "tokens.json").read_text())["refresh_token"] == "R2"


@pytest.mark.parametrize("argv,expected", [
    ([], "sync"),
    (["--dry-run"], "dry-run"),
    (["--simulate"], "simulate"),
])
def test_parse_args_modes(sync, monkeypatch, argv, expected):
    monkeypatch.delenv("W2G_MODE", raising=False)
    monkeypatch.delenv("SIMULATE", raising=False)
    assert sync.parse_args(argv)[0] == expected


def test_invalid_mode_exits(sync, monkeypatch):
    monkeypatch.setenv("W2G_MODE", "nope")
    with pytest.raises(SystemExit):
        sync.parse_args([])


def test_load_withings_tokens_none_when_empty(sync, monkeypatch):
    monkeypatch.delenv("WITHINGS_REFRESH_TOKEN", raising=False)
    assert sync.load_withings_tokens() is None


def test_build_withings_auth_url(sync):
    import urllib.parse
    url = sync.build_withings_auth_url("my_client_id")
    qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    assert qs["client_id"] == ["my_client_id"]
    assert qs["response_type"] == ["code"]
    assert qs["scope"] == ["user.metrics,user.info"]
    assert "ploa33.github.io" in qs["redirect_uri"][0]
    # Raw secret string must NOT be present literally in the URL (avoids GitHub Actions secret scrubbing)
    assert "my_client_id" not in url


def test_extract_withings_code(sync):
    assert sync.extract_withings_code("abc123xyz") == "abc123xyz"
    assert sync.extract_withings_code("http://localhost:8080/?code=abc123xyz&state=init") == "abc123xyz"
    assert sync.extract_withings_code("https://ploa33.github.io/sync-withings2garmin/?code=abc123xyz") == "abc123xyz"
    assert sync.extract_withings_code("  my_code_only  ") == "my_code_only"


def test_first_run_without_tokens_or_code_exits_cleanly(sync, monkeypatch):
    monkeypatch.delenv("WITHINGS_REFRESH_TOKEN", raising=False)
    monkeypatch.delenv("WITHINGS_CODE", raising=False)
    monkeypatch.setenv("WITHINGS_CLIENT_ID", "dummy_id")
    monkeypatch.setenv("WITHINGS_CLIENT_SECRET", "dummy_secret")
    monkeypatch.setenv("GARMIN_EMAIL", "dummy@example.com")
    monkeypatch.setenv("GARMIN_PASSWORD", "dummy_pass")

    summaries = []
    warnings = []
    garmin_calls = []
    monkeypatch.setattr(sync, "gh_summary", lambda text: summaries.append(text))
    monkeypatch.setattr(sync, "gh_warning", lambda text: warnings.append(text))
    monkeypatch.setattr(sync, "get_garmin_client", lambda e, p: garmin_calls.append((e, p)))

    with pytest.raises(SystemExit) as exc_info:
        sync.main()

    # Must exit 0 to prevent GitHub from sending failure notification emails
    assert exc_info.value.code == 0
    assert len(summaries) == 1
    assert "Initial Setup Required" in summaries[0]
    assert len(warnings) == 1
    assert "No Withings token found" in warnings[0]
    assert garmin_calls == [("dummy@example.com", "dummy_pass")]


class _Resp:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


def _fake_notify(monkeypatch, sync, responses):
    calls = []

    def fake_post(url, data=None, **kwargs):
        calls.append(data["action"])
        return _Resp(responses[data["action"]])

    monkeypatch.setattr(sync.requests, "post", fake_post)
    return calls


def test_webhook_status_293_is_reported_as_failure(sync, monkeypatch, capsys):
    monkeypatch.setattr(sync, "WEBHOOK_URL", "https://example.com/hook")
    calls = _fake_notify(monkeypatch, sync, {
        "list": {"status": 0, "body": {"profiles": []}},
        "subscribe": {"status": 293},
    })
    sync.ensure_withings_webhook("token")
    out = capsys.readouterr().out
    assert calls == ["list", "subscribe"]
    assert "293" in out
    assert "webhook active" not in out


def test_webhook_already_subscribed_skips_subscribe(sync, monkeypatch, capsys):
    monkeypatch.setattr(sync, "WEBHOOK_URL", "https://example.com/hook")
    calls = _fake_notify(monkeypatch, sync, {
        "list": {"status": 0, "body": {"profiles": [{"callbackurl": "https://example.com/hook"}]}},
    })
    sync.ensure_withings_webhook("token")
    assert calls == ["list"]
    assert "webhook active" in capsys.readouterr().out


def test_health_metrics_masked_by_default(sync):
    payload = {
        "weight": 75.0,
        "percent_fat": 15.0,
        "muscle_mass": 35.0,
        "percent_hydration": 55.0,
        "bone_mass": 3.0,
        "visceral_fat_rating": 4.0,
    }
    dt = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)
    cells_masked = sync.describe(dt, payload, show_values=False)
    assert cells_masked[0] == "2026-10-15 12:00 UTC"
    for cell in cells_masked[1:]:
        assert cell == "✓ recorded"
        assert "75" not in cell
        assert "15" not in cell
        assert "4" not in cell

    cells_raw = sync.describe(dt, payload, show_values=True)
    assert "75.0 kg" in cells_raw[1]
    assert "15.0 %" in cells_raw[2]
    assert cells_raw[6] == "4.0"

    # Missing visceral fat rating produces "--"
    payload_without_visceral = dict(payload)
    del payload_without_visceral["visceral_fat_rating"]
    cells_missing = sync.describe(dt, payload_without_visceral, show_values=True)
    assert cells_missing[6] == "--"


def test_get_github_oidc_token(sync, monkeypatch):
    monkeypatch.setenv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://actions.local/token")
    monkeypatch.setenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "header_token")

    def fake_get(url, headers=None, params=None, timeout=None):
        assert headers["Authorization"] == "Bearer header_token"
        assert params["audience"] == "withings-sync-relay"
        return _Resp({"value": "jwt_oidc_value"})

    monkeypatch.setattr(sync.requests, "get", fake_get)
    assert sync.get_github_oidc_token() == "jwt_oidc_value"


def test_relay_register_run1_and_run2(sync, monkeypatch):
    monkeypatch.setattr(sync, "get_github_oidc_token", lambda: "oidc_jwt")

    posts = []

    def fake_post(url, headers=None, json=None, timeout=None):
        assert headers["Authorization"] == "Bearer oidc_jwt"
        posts.append(json)
        if not json.get("withings_userid"):
            return _Resp({"status": 0, "state": "signed_state_123", "installed": True})
        return _Resp({"status": 0, "webhook_url": "https://relay.workers.dev/hook?sig=abc"})

    class _RespWithStatus(_Resp):
        def __init__(self, data, status_code=200):
            super().__init__(data)
            self.status_code = status_code

    monkeypatch.setattr(sync.requests, "post", lambda u, **k: _RespWithStatus(
        {"status": 0, "state": "signed_state_123", "installed": True}
        if not (k.get("json") or {}).get("withings_userid")
        else {"status": 0, "webhook_url": "https://relay.workers.dev/hook?sig=abc"}
    ))

    # Run 1: no userid
    res1 = sync.relay_register("https://relay.workers.dev")
    assert res1["state"] == "signed_state_123"
    assert res1["installed"] is True

    # Run 2: with userid
    res2 = sync.relay_register("https://relay.workers.dev", withings_userid="98765")
    assert res2["webhook_url"] == "https://relay.workers.dev/hook?sig=abc"

    # Non-HTTPS relay URL must be rejected
    assert sync.relay_register("http://relay.workers.dev") is None


def test_ensure_withings_webhook_uses_relay_when_configured(sync, monkeypatch, capsys):
    monkeypatch.setattr(sync, "WEBHOOK_URL", "")
    monkeypatch.setattr(sync, "RELAY_URL", "https://relay.workers.dev")
    monkeypatch.setattr(sync, "relay_register", lambda u, withings_userid="": {
        "webhook_url": f"https://relay.workers.dev/hook?u={withings_userid}&s=xyz"
    })

    calls = []

    def fake_post(url, data=None, **kwargs):
        calls.append(data["action"])
        if data["action"] == "list":
            return _Resp({"status": 0, "body": {"profiles": []}})
        if data["action"] == "subscribe":
            assert data["callbackurl"] == "https://relay.workers.dev/hook?u=12345&s=xyz"
            return _Resp({"status": 0})
        return _Resp({"status": -1})

    monkeypatch.setattr(sync.requests, "post", fake_post)
    sync.ensure_withings_webhook("token", userid="12345")
    assert calls == ["list", "subscribe"]
    assert "real-time webhook subscribed" in capsys.readouterr().out


if __name__ == "__main__":
    sys.exit(pytest.main([__file__]))
