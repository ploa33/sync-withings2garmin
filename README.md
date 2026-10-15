# Withings → Garmin Connect

[![Marketplace](https://img.shields.io/badge/Marketplace-Withings_to_Garmin-blue?logo=github-actions&logoColor=white)](https://github.com/marketplace/actions/withings-to-garmin-connect-sync)
[![Release](https://img.shields.io/github/v/release/ploa33/sync-withings2garmin?logo=github)](https://github.com/ploa33/sync-withings2garmin/releases)
[![CI](https://github.com/ploa33/sync-withings2garmin/actions/workflows/ci.yml/badge.svg)](https://github.com/ploa33/sync-withings2garmin/actions/workflows/ci.yml)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Support-orange.svg?logo=buy-me-a-coffee)](https://buymeacoffee.com/ploa33)

Automatically sync weigh-ins and body metrics from any **Withings Scale** (Body, Body+, Body Smart, Body Scan, Body Comp, Body Cardio) to **Garmin Connect** using GitHub Actions — 100% free, private, and serverless.

**Tracked Metrics:** `Weight` · `Body Fat %` · `Muscle Mass` · `Body Water %` · `Bone Mass`

---

## ⚡ Quick Setup (3 minutes)

### 1. Create your private repository

[![Use this template](https://img.shields.io/badge/Use%20this%20template-2ea44f?style=for-the-badge&logo=github&logoColor=white)](https://github.com/new?template_name=sync-withings2garmin&template_owner=ploa33)

> [!IMPORTANT]
> Keep your repository **Private** to protect your health metrics and credentials.

---

### 2. Get Withings API credentials

In the [Withings Developer Dashboard](https://developer.withings.com/dashboard/), click **Create an application** (or edit existing):

| Field | Value to enter |
|---|---|
| **Application Name** | `Withings to Garmin Sync` |
| **Application Description** | `Scale sync to Garmin Connect` |
| **Registered URLs** | `https://ploa33.github.io/sync-withings2garmin/` |

Click **Done**, then keep your **Client ID** and **Consumer Secret** handy.

---

### 3. Add GitHub Secrets

In your new repository, go to **Settings → Secrets and variables → Actions** → **New repository secret**:

| Secret Name | Value |
|---|---|
| `GARMIN_EMAIL` | Garmin Connect email |
| `GARMIN_PASSWORD` | Garmin Connect password |
| `WITHINGS_CLIENT_ID` | Client ID from Step 2 |
| `WITHINGS_CLIENT_SECRET` | Consumer Secret from Step 2 |

---

### 4. Authorize & First Sync

1. Go to **Actions → Withings → Garmin Sync → Run workflow** (leave fields empty).
2. Open the completed run → **Summary** tab → click **[👉 Click here to authorise Withings]**.
3. Log in, approve permissions, then click **📋 Copy Code** on the confirmation page.
4. Back in the **Actions** tab, click **Run workflow**, paste the code into **`withings_code`**, and launch!

> 🎉 **Done!** Your weigh-ins are synced, and OAuth tokens rotate automatically on every future run. Zero maintenance required.

---

<details>
<summary><b>🔐 Garmin 2-Factor Authentication (2FA / MFA)</b></summary>

If your Garmin account has two-factor authentication enabled:
* When running Step 4 above with your `withings_code`, also enter your current verification code (TOTP authenticator app or email code) in the **`garmin_mfa_code`** field.
* The session is saved securely to your private state branch — MFA is never needed again.

</details>

<details>
<summary><b>⚡ Real-Time Instant Sync (Optional Webhook Relay)</b></summary>

By default, the workflow runs twice daily (**09:00 & 22:00**). To upload weigh-ins **instantly** when stepping off your scale:

1. **GitHub Token:** Create a [Fine-Grained PAT](https://github.com/settings/personal-access-tokens/new) (1-year expiration, **Contents: Read & write** on your private sync repo) or a [Classic PAT](https://github.com/settings/tokens/new) with the `repo` scope.
2. **Google Apps Script:** Open [script.google.com](https://script.google.com/) → **New project**, paste:

```javascript
const REPO  = "YOUR_GITHUB_USERNAME/YOUR_PRIVATE_REPO"; // e.g. "octocat/my-sync"
const TOKEN = "ghp_... or github_pat_...";

function doPost(e) {
  const resp = UrlFetchApp.fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: "post",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
    payload: JSON.stringify({ event_type: "withings_sync" }),
    muteHttpExceptions: true,
  });
  console.log("GitHub API Status: " + resp.getResponseCode());
  return ContentService.createTextOutput("OK");
}

function doGet(e) {
  return ContentService.createTextOutput("Withings Webhook Active");
}
```

3. **Deploy:** Click **Deploy → New deployment** → Type: **Web app** → Execute as: **Me** → Who has access: **Anyone** → **Deploy**.
4. **Secret:** Add the deployed URL as **`WEBHOOK_URL`** in your repository's GitHub Secrets.

The workflow registers this webhook with Withings automatically on the next run!

> [!TIP]
> If you ever update the script or token later, always go to **Deploy → Manage deployments → Edit ✏️ → Version: New version → Deploy** to publish your changes.

</details>

<details>
<summary><b>🛠️ How It Works & Architecture</b></summary>

```mermaid
flowchart LR
  S[Scale] --> W[Withings Cloud]
  W -. webhook .-> G[Apps Script Relay] -. dispatch .-> A[Private Repo: sync.yml]
  C[Scheduled Cron: 9h & 22h] --> A
  A -- uses: ploa33/sync-withings2garmin@v1 --> M[Garmin Connect]
  A <--> B[(withings2garmin-state)]
```

* **Zero Infrastructure:** Runs entirely on GitHub Actions runners.
* **100% Private:** Direct API communication between Withings, Garmin, and your private runner. No third-party servers.
* **Isolated State:** Tokens and SSO session are saved to an orphan single-commit branch (`withings2garmin-state`) without cluttering git history.
* **Smart De-duplication:** Only uploads weigh-ins newer than the last recorded timestamp.

</details>

---

## ☕ Support

If this saved you the cost of a Garmin Index scale, consider supporting the project:

<a href="https://buymeacoffee.com/ploa33" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="42"></a>

## 📄 License & Disclaimer

Distributed under the [MIT License](LICENSE).

*This project is an independent open-source tool and is not affiliated, associated, authorized, endorsed by, or in any way officially connected with Garmin Ltd., Withings SA, or any of their subsidiaries.*
