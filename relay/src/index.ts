/**
 * Universal Stateless Relay for Withings → Garmin Connect Sync
 * Runs on Cloudflare Workers (100% serverless, zero database, zero logs).
 *
 * Endpoints:
 *  1. POST /register - Validates GitHub Actions OIDC token, returns signed state + webhook URL.
 *  2. GET  /oauth    - Withings OAuth callback: automatically triggers sync.yml via GitHub App.
 *  3. *    /hook     - Webhook endpoint for Withings real-time weigh-in notifications.
 */

export interface Env {
  GH_APP_ID: string;
  GH_APP_PRIVATE_KEY: string;
  HMAC_SECRET: string;
  GH_APP_SLUG?: string;
}

const REPO_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const SECURITY_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Web Crypto Helpers ───────────────────────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) {
    str += "=";
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signHmac(secret: string, data: string): Promise<string> {
  const key = await getHmacKey(secret);
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return base64UrlEncode(new Uint8Array(sig));
}

async function verifyHmac(secret: string, data: string, signature: string): Promise<boolean> {
  try {
    const key = await getHmacKey(secret);
    const enc = new TextEncoder();
    const sigBytes = base64UrlDecode(signature);
    return await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(data));
  } catch {
    return false;
  }
}

// ── GitHub App JWT Generation (RS256) ────────────────────────────────────────

function pemToBinary(pem: string): Uint8Array {
  const clean = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  return base64UrlDecode(clean);
}

async function getAppPrivateKey(pem: string): Promise<CryptoKey> {
  const binary = pemToBinary(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    binary,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function generateAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: appId.trim(),
  };

  const enc = new TextEncoder();
  const headerB64 = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getAppPrivateKey(privateKeyPem);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signingInput));
  const sigB64 = base64UrlEncode(new Uint8Array(sig));

  return `${signingInput}.${sigB64}`;
}

// ── GitHub Actions OIDC Validation ──────────────────────────────────────────

interface GitHubOidcClaims {
  iss: string;
  aud: string | string[];
  repository: string;
  repository_owner: string;
  exp: number;
}

let jwksCache: { keys: any[]; expires: number } | null = null;

async function getGitHubJwks(): Promise<any[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.expires > now) {
    return jwksCache.keys;
  }
  const resp = await fetch("https://token.actions.githubusercontent.com/.well-known/jwks");
  if (!resp.ok) {
    throw new Error(`Failed to fetch GitHub JWKS: ${resp.status}`);
  }
  const data = (await resp.json()) as { keys: any[] };
  jwksCache = { keys: data.keys, expires: now + 3600 * 1000 };
  return data.keys;
}

async function verifyGitHubOidcToken(token: string): Promise<GitHubOidcClaims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))) as GitHubOidcClaims;

    if (payload.iss !== "https://token.actions.githubusercontent.com") {
      return null;
    }
    const audOk = Array.isArray(payload.aud)
      ? payload.aud.includes("withings-sync-relay")
      : payload.aud === "withings-sync-relay";
    if (!audOk) {
      return null;
    }
    if (!payload.repository || !REPO_REGEX.test(payload.repository)) {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return null;
    }

    const keys = await getGitHubJwks();
    const matchingKey = keys.find((k) => k.kid === header.kid);
    if (!matchingKey) return null;

    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      matchingKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const enc = new TextEncoder();
    const signedData = enc.encode(`${parts[0]}.${parts[1]}`);
    const sigBytes = base64UrlDecode(parts[2]);

    const isValid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, sigBytes, signedData);
    return isValid ? payload : null;
  } catch {
    return null;
  }
}

// ── GitHub App API Helpers ──────────────────────────────────────────────────

async function getInstallationAccessToken(
  env: Env,
  owner: string,
  repo: string
): Promise<{ token: string; installed: boolean } | null> {
  try {
    const appJwt = await generateAppJwt(env.GH_APP_ID, env.GH_APP_PRIVATE_KEY);
    const installResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "withings-sync-relay",
      },
    });

    if (installResp.status === 404) {
      return { token: "", installed: false };
    }
    if (!installResp.ok) {
      return null;
    }

    const installData = (await installResp.json()) as { id: number };
    const tokenResp = await fetch(`https://api.github.com/app/installations/${installData.id}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "withings-sync-relay",
      },
      body: JSON.stringify({
        permissions: { actions: "write" },
      }),
    });

    if (!tokenResp.ok) {
      return null;
    }
    const tokenData = (await tokenResp.json()) as { token: string };
    return { token: tokenData.token, installed: true };
  } catch {
    return null;
  }
}

async function triggerWorkflowDispatch(
  token: string,
  repo: string,
  inputs?: Record<string, string>
): Promise<boolean> {
  if (!REPO_REGEX.test(repo)) return false;
  for (const ref of ["main", "master"]) {
    try {
      const resp = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/sync.yml/dispatches`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "withings-sync-relay",
        },
        body: JSON.stringify({
          ref,
          inputs: inputs || {},
        }),
      });
      if (resp.status === 204) {
        return true;
      }
    } catch {
      // try fallback ref
    }
  }
  return false;
}

// ── HTML Views ──────────────────────────────────────────────────────────────

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...SECURITY_HEADERS,
    },
  });
}

function renderSuccessPage(repo: string): Response {
  const safeRepo = REPO_REGEX.test(repo) ? escapeHtml(repo) : "";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Withings → Garmin Sync</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      background: radial-gradient(circle at 50% 0%, #161f2c 0%, #0d1117 70%);
      color: #c9d1d9;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
    }
    .card {
      background: rgba(22, 27, 34, 0.88);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(240, 246, 252, 0.1);
      border-radius: 16px;
      max-width: 480px;
      width: 100%;
      padding: 36px 32px;
      text-align: center;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);
    }

    /* ── Withings → Garmin Sync Animation ── */
    .sync-flow {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      margin: 0 auto 28px;
      padding: 18px 22px;
      background: rgba(13, 17, 23, 0.65);
      border: 1px solid rgba(240, 246, 252, 0.07);
      border-radius: 14px;
      max-width: 340px;
    }
    .brand-node {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    .brand-tile {
      width: 64px;
      height: 64px;
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #161b22;
      border: 1px solid rgba(240, 246, 252, 0.12);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
    }
    .brand-tile.withings {
      background: linear-gradient(145deg, #13252b 0%, #0d1519 100%);
      border-color: rgba(0, 210, 190, 0.35);
      animation: pulseSource 2.4s ease-in-out infinite;
    }
    .brand-tile.garmin {
      background: linear-gradient(145deg, #112032 0%, #0d141d 100%);
      border-color: rgba(0, 124, 195, 0.4);
      animation: pulseTarget 2.4s ease-in-out infinite;
    }
    .brand-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #8b949e;
    }

    /* Animated Stream Between Nodes */
    .stream-track {
      flex: 1;
      height: 36px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
      min-width: 88px;
      margin-bottom: 18px;
    }
    .stream-line {
      width: 100%;
      height: 2px;
      background: rgba(240, 246, 252, 0.1);
      border-radius: 2px;
      position: relative;
      overflow: hidden;
    }
    .stream-packet {
      position: absolute;
      top: 0;
      left: -45%;
      width: 45%;
      height: 100%;
      background: linear-gradient(90deg, transparent, #00d2be, #388bfd);
      border-radius: 2px;
      animation: flowPacket 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
    .stream-chevrons {
      display: flex;
      gap: 4px;
      margin-top: 6px;
    }
    .stream-chevrons span {
      font-size: 13px;
      line-height: 1;
      font-weight: 700;
      opacity: 0.25;
      animation: chevronWave 1.8s infinite;
    }
    .stream-chevrons span:nth-child(1) { animation-delay: 0.0s; color: #00d2be; }
    .stream-chevrons span:nth-child(2) { animation-delay: 0.25s; color: #1ca8d6; }
    .stream-chevrons span:nth-child(3) { animation-delay: 0.5s; color: #388bfd; }

    @keyframes flowPacket {
      0%   { left: -45%; opacity: 0.3; }
      30%  { opacity: 1; }
      80%  { opacity: 1; }
      100% { left: 105%; opacity: 0; }
    }
    @keyframes chevronWave {
      0%, 100% { opacity: 0.2; transform: translateX(0); }
      40% { opacity: 1; transform: translateX(2px); }
    }
    @keyframes pulseSource {
      0%, 100% { box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35), 0 0 0 0 rgba(0, 210, 190, 0); }
      20% { box-shadow: 0 6px 20px rgba(0, 210, 190, 0.22), 0 0 0 4px rgba(0, 210, 190, 0.08); }
    }
    @keyframes pulseTarget {
      0%, 60%, 100% { box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35), 0 0 0 0 rgba(56, 139, 253, 0); }
      85% { box-shadow: 0 6px 22px rgba(56, 139, 253, 0.28), 0 0 0 4px rgba(56, 139, 253, 0.1); }
    }

    /* ── Sleek Status Chip ── */
    .status-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 5px 14px 5px 7px;
      border-radius: 999px;
      font-size: 12.5px;
      font-weight: 500;
      letter-spacing: 0.02em;
      margin-bottom: 16px;
      background: rgba(255, 255, 255, 0.03);
      color: #e6edf3;
      border: 1px solid rgba(240, 246, 252, 0.1);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }
    .status-icon {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: linear-gradient(135deg, #2ea043 0%, #238636 100%);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 10px rgba(46, 160, 67, 0.45);
    }

    h1 {
      color: #f0f6fc;
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -0.01em;
      margin: 0 0 12px;
    }
    p {
      font-size: 14px;
      line-height: 1.6;
      color: #8b949e;
      margin: 0 0 26px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px 22px;
      font-size: 14px;
      font-weight: 600;
      color: #ffffff;
      background: linear-gradient(180deg, #2ea043 0%, #238636 100%);
      border: 1px solid rgba(240, 246, 252, 0.15);
      border-radius: 10px;
      text-decoration: none;
      transition: all 0.2s ease;
      box-shadow: 0 4px 12px rgba(35, 134, 54, 0.3);
    }
    .btn:hover {
      background: linear-gradient(180deg, #3fb950 0%, #2ea043 100%);
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(46, 160, 67, 0.4);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="sync-flow" aria-label="Syncing from Withings to Garmin">
      <!-- Withings Node -->
      <div class="brand-node">
        <div class="brand-tile withings">
          <svg width="38" height="38" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="6" y="6" width="28" height="28" rx="8" stroke="#00d2be" stroke-width="2" fill="rgba(0,210,190,0.08)"/>
            <path d="M20 11 A6 6 0 0 1 26 17 L14 17 A6 6 0 0 1 20 11 Z" fill="rgba(0,210,190,0.25)" stroke="#00d2be" stroke-width="1.5"/>
            <line x1="20" y1="17" x2="22.5" y2="13" stroke="#00d2be" stroke-width="1.8" stroke-linecap="round"/>
            <text x="20" y="28.5" text-anchor="middle" fill="#f0f6fc" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="6.2" font-weight="800" letter-spacing="0.8">WITHINGS</text>
          </svg>
        </div>
        <span class="brand-label">Withings</span>
      </div>

      <!-- Animated Flow -->
      <div class="stream-track">
        <div class="stream-line">
          <div class="stream-packet"></div>
        </div>
        <div class="stream-chevrons">
          <span>›</span><span>›</span><span>›</span>
        </div>
      </div>

      <!-- Garmin Node -->
      <div class="brand-node">
        <div class="brand-tile garmin">
          <svg width="42" height="42" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
            <polygon points="22,9 28.5,20 15.5,20" fill="#007cc3"/>
            <text x="22" y="31" text-anchor="middle" fill="#f0f6fc" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="8.2" font-weight="900" letter-spacing="0.9">GARMIN</text>
          </svg>
        </div>
        <span class="brand-label">Garmin</span>
      </div>
    </div>

    <div class="status-chip">
      <span class="status-icon">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M13.2 4.8L6.5 11.5L2.8 7.8" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <span>Authorization Complete</span>
    </div>

    <h1>Sync Launched Automatically!</h1>
    <p>Withings authorization succeeded. The relay has automatically triggered your sync workflow on GitHub Actions. You can now close this tab.</p>
    ${safeRepo ? `<a class="btn" href="https://github.com/${safeRepo}/actions" target="_blank" rel="noreferrer">View Workflow on GitHub →</a>` : ""}
  </div>
  <script>try{history.replaceState({},document.title,location.pathname);}catch(e){}</script>
</body>
</html>`;
  return htmlResponse(html);
}

function renderManualFallbackPage(code: string, repo: string): Response {
  const safeCode = escapeHtml(code);
  const safeRepo = REPO_REGEX.test(repo) ? escapeHtml(repo) : "";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Withings Authorization Code</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; max-width: 460px; width: 100%; padding: 32px; text-align: center; }
    h1 { color: #f0f6fc; font-size: 20px; margin: 0 0 10px; }
    p { font-size: 14px; line-height: 1.5; color: #8b949e; margin: 0 0 16px; }
    .code-box { background: #0d1117; border: 1px solid #388bfd; border-radius: 8px; padding: 12px; font-family: monospace; font-size: 15px; color: #58a6ff; word-break: break-all; margin-bottom: 16px; user-select: all; }
    .btn { display: block; width: 100%; box-sizing: border-box; padding: 10px 16px; font-size: 14px; font-weight: 600; color: #fff; background: #238636; border-radius: 8px; border: none; cursor: pointer; text-decoration: none; margin-bottom: 10px; }
    .btn:hover { background: #2ea44f; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 40px; margin-bottom: 12px;">📋</div>
    <h1>Copy Authorization Code</h1>
    <p>Paste this code into <code>withings_code</code> in your GitHub Actions workflow:</p>
    <div class="code-box" id="code-val">${safeCode}</div>
    <button class="btn" id="copy-btn" onclick="copy()">📋 Copy Code</button>
    ${safeRepo ? `<a class="btn" style="background:#21262d;border:1px solid #30363d;" href="https://github.com/${safeRepo}/actions/workflows/sync.yml" target="_blank" rel="noreferrer">Open GitHub Actions →</a>` : ""}
  </div>
  <script>
    try{history.replaceState({},document.title,location.pathname);}catch(e){}
    function copy() {
      const txt = document.getElementById('code-val').textContent;
      navigator.clipboard.writeText(txt).then(() => {
        document.getElementById('copy-btn').textContent = '✅ Copied!';
      });
    }
  </script>
</body>
</html>`;
  return htmlResponse(html);
}

// ── Main Worker Export ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── 0. Root health page: GET / ─────────────────────────────────────────
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return htmlResponse(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Withings → Garmin Relay</title>
<style>body{font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.c{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px;max-width:400px;text-align:center}a{color:#58a6ff;text-decoration:none}</style></head>
<body><div class="c"><div style="font-size:36px">⚖️</div><h2 style="color:#f0f6fc;margin:10px 0 6px">Withings → Garmin Relay</h2><p style="font-size:13px;color:#8b949e;margin:0 0 16px">Stateless OAuth &amp; webhook bridge · Zero data storage</p><a href="https://github.com/ploa33/sync-withings2garmin">View Documentation on GitHub →</a></div></body></html>`);
    }

    // ── 1. Webhook endpoint: /hook ─────────────────────────────────────────
    if (url.pathname === "/hook") {
      if (request.method === "HEAD" || request.method === "GET") {
        return new Response("OK", { status: 200, headers: SECURITY_HEADERS });
      }

      if (request.method === "POST") {
        const repo = url.searchParams.get("r") || "";
        const expectedUserid = url.searchParams.get("u") || "";
        const sig = url.searchParams.get("s") || "";

        if (!repo || !expectedUserid || !sig || !REPO_REGEX.test(repo)) {
          return new Response("Missing or invalid parameters", { status: 400, headers: SECURITY_HEADERS });
        }

        const expectedData = `${repo}:${expectedUserid}`;
        const isValid = await verifyHmac(env.HMAC_SECRET, expectedData, sig);
        if (!isValid) {
          return new Response("Invalid signature", { status: 403, headers: SECURITY_HEADERS });
        }

        try {
          const bodyText = await request.text();
          const params = new URLSearchParams(bodyText);
          const receivedUserid = params.get("userid");
          if (receivedUserid && String(receivedUserid) !== expectedUserid) {
            return new Response("User ID mismatch", { status: 403, headers: SECURITY_HEADERS });
          }
        } catch {
          // ignore empty body
        }

        ctx.waitUntil(
          (async () => {
            const [owner, name] = repo.split("/");
            if (!owner || !name) return;
            const creds = await getInstallationAccessToken(env, owner, name);
            if (creds && creds.installed) {
              await triggerWorkflowDispatch(creds.token, repo);
            }
          })()
        );

        return new Response("OK", { status: 200, headers: SECURITY_HEADERS });
      }

      return new Response("Method Not Allowed", { status: 405, headers: SECURITY_HEADERS });
    }

    // ── 2. Register endpoint: POST /register ────────────────────────────────
    if (url.pathname === "/register" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization") || "";
      const oidcToken = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (!oidcToken) {
        return new Response(JSON.stringify({ error: "Missing OIDC token" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
        });
      }

      const claims = await verifyGitHubOidcToken(oidcToken);
      if (!claims) {
        return new Response(JSON.stringify({ error: "Invalid OIDC token" }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
        });
      }

      const repo = claims.repository;
      const [owner, name] = repo.split("/");
      const creds = await getInstallationAccessToken(env, owner, name);
      const installed = creds?.installed ?? false;

      // Signed state for OAuth (valid 15 minutes)
      const exp = Math.floor(Date.now() / 1000) + 900;
      const stateData = `${repo}:${exp}`;
      const stateSig = await signHmac(env.HMAC_SECRET, stateData);
      const state = `${btoa(stateData)}.${stateSig}`;

      let webhookUrl: string | null = null;
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        // empty body
      }

      if (body.withings_userid && /^[0-9]+$/.test(String(body.withings_userid))) {
        const u = String(body.withings_userid);
        const hookSig = await signHmac(env.HMAC_SECRET, `${repo}:${u}`);
        webhookUrl = `${url.origin}/hook?r=${encodeURIComponent(repo)}&u=${encodeURIComponent(u)}&s=${hookSig}`;
      }

      return new Response(
        JSON.stringify({
          status: 0,
          repo,
          installed,
          state,
          webhook_url: webhookUrl,
          relay_oauth_url: `${url.origin}/oauth`,
          app_slug: env.GH_APP_SLUG || "relay-withings2garmin",
        }),
        { headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } }
      );
    }

    // ── 3. OAuth callback endpoint: GET /oauth ─────────────────────────────
    if (url.pathname === "/oauth" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        return new Response(`Withings authorization denied: ${escapeHtml(error)}`, {
          status: 400,
          headers: SECURITY_HEADERS,
        });
      }
      if (!code || !state) {
        return new Response("Missing code or state", { status: 400, headers: SECURITY_HEADERS });
      }

      const [encodedData, sig] = state.split(".");
      if (!encodedData || !sig) {
        return renderManualFallbackPage(code, "");
      }

      let stateData = "";
      try {
        stateData = atob(encodedData);
      } catch {
        return renderManualFallbackPage(code, "");
      }

      const isValid = await verifyHmac(env.HMAC_SECRET, stateData, sig);
      if (!isValid) {
        return new Response("Invalid or forged state parameter", { status: 403, headers: SECURITY_HEADERS });
      }

      const [repo, expStr] = stateData.split(":");
      const exp = parseInt(expStr || "0", 10);
      if (exp < Math.floor(Date.now() / 1000)) {
        return new Response("Authorization link expired (15 min limit). Please re-run the workflow.", {
          status: 400,
          headers: SECURITY_HEADERS,
        });
      }

      if (!repo || !REPO_REGEX.test(repo)) {
        return renderManualFallbackPage(code, "");
      }

      const [owner, name] = repo.split("/");
      const creds = await getInstallationAccessToken(env, owner, name);
      if (!creds || !creds.installed) {
        return renderManualFallbackPage(code, repo);
      }

      const dispatched = await triggerWorkflowDispatch(creds.token, repo, {
        withings_code: code,
      });

      if (dispatched) {
        return renderSuccessPage(repo);
      } else {
        return renderManualFallbackPage(code, repo);
      }
    }

    return new Response("Not Found", { status: 404, headers: SECURITY_HEADERS });
  },
};
