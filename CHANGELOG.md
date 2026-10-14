# Changelog

All notable changes to this project are documented here. Versions follow [SemVer](https://semver.org/):
users on `@v1` receive every `v1.x.y` automatically.

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
