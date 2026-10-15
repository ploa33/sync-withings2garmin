# Withings → Garmin Universal Relay

This directory contains the Cloudflare Worker relay for the **Withings → Garmin Connect Sync** project.

It provides a **100% serverless, stateless bridge** that:
1. Receives the Withings OAuth2 authorization code callback and triggers the user's private repository workflow automatically (eliminating the 30-second manual copy-paste race).
2. Receives Withings real-time weigh-in webhooks and dispatches GitHub Actions runs instantly.

Zero personal health data, credentials, or metrics ever touch or pass through this relay.

---

## 🚀 Setup & Deployment (Maintainer only)

### 1. Create the GitHub App

1. Go to **[GitHub Developer Settings → GitHub Apps → New GitHub App](https://github.com/settings/apps/new)**:
   - **GitHub App name:** `Withings to Garmin Sync` (or similar)
   - **Homepage URL:** `https://github.com/ploa33/sync-withings2garmin`
   - **Callback URL:** `https://withings-sync-relay.<your-subdomain>.workers.dev/oauth`
   - **Webhook:** Uncheck **Active** (no incoming webhooks needed from GitHub).
2. **Permissions:**
   - **Repository permissions → Actions:** `Read and write` (needed to dispatch `sync.yml`).
   - **Repository permissions → Metadata:** `Read-only` (default).
3. **Where can this GitHub App be installed?**
   - Select **Any account** (allows users to install it on their private repository).
4. Click **Create GitHub App**.
5. Save your **App ID** (shown under General Settings).
6. Under **Private keys**, click **Generate a private key** and download the `.pem` file.

---

### 2. Configure & Deploy the Cloudflare Worker

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set the secrets in your Cloudflare Worker:
   ```bash
   npx wrangler secret put GH_APP_ID
   # Paste your App ID (e.g. 123456)

   npx wrangler secret put GH_APP_PRIVATE_KEY
   # Paste the entire content of the downloaded .pem file (including BEGIN/END headers)

   npx wrangler secret put HMAC_SECRET
   # Enter a secure random string (at least 32 characters)
   ```

3. Deploy to Cloudflare:
   ```bash
   npm run deploy
   ```

Your relay is now active and ready to serve all users of `ploa33/sync-withings2garmin`!
