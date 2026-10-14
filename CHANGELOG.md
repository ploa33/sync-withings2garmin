# Changelog

All notable changes to this project are documented here. Versions follow [SemVer](https://semver.org/):
users on `@v1` receive every `v1.x.y` automatically.

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
