# Changelog

All notable changes to this project are documented here. Versions follow [SemVer](https://semver.org/):
users on `@v1` receive every `v1.x.y` automatically.

## [1.4.0] - 2026-10-19

### Added
- **Visceral Fat Rating Sync**: Automatically syncs visceral fat index (Withings measure type 125) to Garmin Connect (`visceral_fat_rating`) for Withings Body Scan, Body Scan 2, and Body Comp scales.
- Updated Job Summary table and logs to display visceral fat ratings.

## [1.3.0] - 2026-10-15

### Added
- **Universal Cloudflare Worker Relay (`relay/`)**: 100% serverless, zero-database companion relay for 1-click Withings OAuth authorization and instant real-time weigh-in sync without Google Apps Script.
- **GitHub Actions OIDC Authentication**: secure repository identification via `id-token: write` and GitHub JWKS verification without needing user Personal Access Tokens.
- **Early Garmin Pre-flight Validation**: verifies Garmin credentials and saves the session on Run 1 before presenting the Withings authorization link, failing fast on typos or MFA requirements.
- **Biometric Health Privacy in Logs**: weight and body composition values are masked by default (`✓ recorded`) in console output and Job Summary, with optional `W2G_SHOW_METRICS=true` toggle.
- **Automatic Webhook Lifecycle**: subscribes the signed relay webhook URL to Withings `/notify` automatically on first sync.

### Fixed
- **Withings Webhook Status Code 293**: properly treated as an error (failed HEAD probe validation) rather than active webhook, checking existing subscriptions with `action=list` first.

## [1.2.1] - 2026-10-15

### Added
- Diagnostic secrets table in Job Summary: displays a clear status table (`✅ Configured` / `❌ Missing`) with direct clickable link to repository secrets if any are missing.
- URL auto-cleanup in GitHub Pages callback (`docs/index.html`): removes query parameters from the browser address bar after reading to prevent stale refreshes and protect browser history.
- Streamlined, minimalist README: redesigned into 4 rapid steps with collapsible advanced options.

## [1.2.0] - 2026-10-15

### Added
- Official GitHub Pages 1-click callback helper (`docs/index.html`): displays a clean, client-side confirmation page with a single-click "Copy Code" button and 30-second expiry timer.
- Dynamic repository links in Job Summary: automatically deep-links users directly to their own repository's "Run workflow" panel via `$GITHUB_SERVER_URL/$GITHUB_REPOSITORY`.
- Smart code extractor: `withings_code` input now accepts full redirect URLs (e.g. copied from browser address bar) as well as raw code strings.
- Markdown configuration table in README for Withings Developer Dashboard setup.

## [1.1.1] - 2026-10-15

### Fixed
- Prevent GitHub Actions secret scrubber from masking authorization URL parameters (`client_id` and `redirect_uri`) with `***` in the Job Summary. All parameters are now percent-encoded so the link works seamlessly in one click.
- Automatic fallback to `http://localhost:8080` during code exchange if the primary `WEBHOOK_URL` redirect URI mismatch occurs.
- Provide dual authorization links in Job Summary when `WEBHOOK_URL` is set, accommodating both Google Apps Script and `http://localhost:8080` configurations in Withings Developer Portal.
- Support `vars.WITHINGS_CLIENT_ID` and `vars.WEBHOOK_URL` in addition to repository secrets.

## [1.1.0] - 2026-10-14

### Added
- Zero-friction Withings OAuth setup: no more `curl` or terminal required. First run provides an interactive Job Summary guide with a pre-filled authorization link, and the code is exchanged via `withings_code` input.
- Immediate token state persistence: tokens are written and saved to the `withings2garmin-state` branch before contacting Garmin, ensuring Withings auth is never lost if Garmin fails.
- Support for Garmin 2-factor authentication (MFA / TOTP) via `garmin_mfa_code` input with clear error guidance.
- Google Apps Script all-in-one relay: supports both real-time weigh-in webhooks (`doPost`) and automatic zero-copy OAuth code dispatch (`doGet`).
- Dynamic `redirect_uri`: automatically uses `WEBHOOK_URL` if defined, or falls back to `http://localhost:8080`.
- Clean first-run exit (`sys.exit(0)`) with `::warning` annotation to prevent false-alarm failure emails.
- Public repository guardrail: aborts run with error if the user accidentally created a public repo instead of private.
- Token log masking: outputs `::add-mask::` on all OAuth tokens, codes, and MFA codes to prevent accidental leaks in Action logs.
- Dedicated concurrency group (`withings2garmin-sync`) to serialize webhook and cron triggers.
- Privacy & Self-Hosted section and Legal Disclaimer added to README.

## [1.0.0] - 2026-10-14

### Added
- Reusable GitHub Action (`uses: ploa33/sync-withings2garmin@v1`): user repositories only contain a ~40-line workflow and receive updates automatically.
- State (Withings tokens, Garmin session, last synced timestamp) stored on a single-commit `withings2garmin-state` branch instead of `main`.
- De-duplication: only weigh-ins newer than the last synced one are uploaded.
- `dry-run` mode (fetch and display only) alongside `simulate` (fake weigh-in upload).
- Job summary table and `synced-count` output.
- Unit tests, CI, release automation.

### Fixed
- State is saved even when a run fails, so the rotating Withings refresh token is never lost.
- Template copies no longer lose their tokens (`.gitignore` prevented them from being saved).
