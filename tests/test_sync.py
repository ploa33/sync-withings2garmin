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
    payload = sync.to_garmin_payload({"weight": 80.0, "fat_mass_weight": 16.0, "hydration": 44.0})
    assert payload["percent_fat"] == 20.0
    assert payload["percent_hydration"] == 55.0
    assert payload["bone_mass"] is None


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
    monkeypatch.setattr(sync, "gh_summary", lambda text: summaries.append(text))
    monkeypatch.setattr(sync, "gh_warning", lambda text: warnings.append(text))

    with pytest.raises(SystemExit) as exc_info:
        sync.main()

    # Must exit 0 to prevent GitHub from sending failure notification emails
    assert exc_info.value.code == 0
    assert len(summaries) == 1
    assert "Initial Setup Required" in summaries[0]
    assert len(warnings) == 1
    assert "No Withings token found" in warnings[0]


if __name__ == "__main__":
    sys.exit(pytest.main([__file__]))
