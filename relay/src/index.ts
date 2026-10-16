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
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Content-Security-Policy":
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
  nbf?: number;
}

let jwksCache: { keys: any[]; expires: number } | null = null;
const hookCooldowns = new Map<string, number>();
const HOOK_COOLDOWN_MS = 15_000;

async function getGitHubJwks(forceRefresh = false): Promise<any[]> {
  const now = Date.now();
  if (!forceRefresh && jwksCache && jwksCache.expires > now) {
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
    if (header.alg !== "RS256") return null;

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
    if (payload.nbf && payload.nbf > now + 60) {
      return null;
    }

    let keys = await getGitHubJwks();
    let matchingKey = keys.find((k) => k.kid === header.kid);
    if (!matchingKey) {
      keys = await getGitHubJwks(true);
      matchingKey = keys.find((k) => k.kid === header.kid);
    }
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
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      background: #161b22;
      border: 1px solid #262c36;
      border-radius: 16px;
      max-width: 420px;
      width: 100%;
      padding: 32px 28px;
      text-align: center;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    }

    /* ── Minimalist Premium Withings → Garmin Header ── */
    .sync-header {
      margin: 0 auto 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      user-select: none;
    }

    .sync-nodes {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      width: 100%;
      max-width: 248px;
    }

    .brand-node {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }

    .brand-tile {
      width: 54px;
      height: 54px;
      border-radius: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      border: 1px solid rgba(240, 246, 252, 0.08);
    }
    .brand-tile.withings {
      background: #ffffff;
    }
    .brand-tile img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .brand-label {
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.02em;
      color: #7d8590;
    }

    /* Minimalist Blue Line Bridge (no arrow, no dashes) */
    .bridge {
      flex: 1;
      display: flex;
      align-items: center;
      margin-bottom: 21px;
      min-width: 72px;
    }
    .bridge-track {
      width: 100%;
      height: 2px;
      background: #21262d;
      border-radius: 2px;
      overflow: hidden;
      position: relative;
    }
    .bridge-fill {
      height: 100%;
      width: 100%;
      background: linear-gradient(90deg, #6e8efb 0%, #00a7e1 100%);
      border-radius: 2px;
      transform: scaleX(0);
      transform-origin: left center;
      animation: fillBridge 0.8s cubic-bezier(0.22, 1, 0.36, 1) 0.15s forwards;
    }

    /* Sober & Premium Authorization Complete */
    .auth-complete {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      margin-top: 14px;
      opacity: 0;
      transform: translateY(2px);
      animation: showAuthComplete 0.35s ease-out 0.9s forwards;
    }
    .auth-complete-icon {
      width: 14px;
      height: 14px;
      display: block;
      flex-shrink: 0;
    }
    .auth-complete-check {
      stroke: #3fb950;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-dasharray: 18;
      stroke-dashoffset: 18;
      animation: drawCheck 0.3s ease-out 1.0s forwards;
    }
    .auth-complete-text {
      font-size: 12px;
      font-weight: 500;
      color: #8b949e;
      letter-spacing: 0.02em;
    }

    @keyframes fillBridge {
      to { transform: scaleX(1); }
    }
    @keyframes showAuthComplete {
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes drawCheck {
      to { stroke-dashoffset: 0; }
    }

    .divider {
      height: 1px;
      background: #21262d;
      margin: 0 auto 22px;
      width: 100%;
    }
    h1 {
      color: #f0f6fc;
      font-size: 19px;
      font-weight: 600;
      letter-spacing: -0.01em;
      margin: 0 0 10px;
    }
    p {
      font-size: 13.5px;
      line-height: 1.55;
      color: #7d8590;
      margin: 0 0 24px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 10px 20px;
      font-size: 13.5px;
      font-weight: 600;
      color: #ffffff;
      background: #238636;
      border: 1px solid rgba(240, 246, 252, 0.1);
      border-radius: 8px;
      text-decoration: none;
      transition: background 0.15s;
    }
    .btn:hover {
      background: #2ea44f;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="sync-header" >
      <div class="sync-nodes">
        <!-- Withings Node -->
        <div class="brand-node">
          <div class="brand-tile withings">
            <img src="data:image/png;base64,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" alt="Withings">
          </div>
          <span class="brand-label">Withings</span>
        </div>

        <!-- Minimalist Blue Line -->
        <div class="bridge">
          <div class="bridge-track">
            <div class="bridge-fill"></div>
          </div>
        </div>

        <!-- Garmin Node -->
        <div class="brand-node">
          <div class="brand-tile garmin">
            <img src="data:image/png;base64,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" alt="Garmin Connect">
          </div>
          <span class="brand-label">Garmin</span>
        </div>
      </div>

      <!-- Minimalist Authorization Complete -->
      <div class="auth-complete">
        <svg class="auth-complete-icon" viewBox="0 0 16 16" fill="none">
          <path class="auth-complete-check" d="M2.5 8.5L6.2 12.2L13.5 4.5" pathLength="18" />
        </svg>
        <span class="auth-complete-text">Authorization Complete</span>
      </div>
    </div>
    <div class="divider"></div>
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

        const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
        if (contentLength > 4096) {
          return new Response("Payload Too Large", { status: 413, headers: SECURITY_HEADERS });
        }

        try {
          const bodyText = await request.text();
          if (bodyText.length > 4096) {
            return new Response("Payload Too Large", { status: 413, headers: SECURITY_HEADERS });
          }
          const params = new URLSearchParams(bodyText);
          const receivedUserid = params.get("userid");
          if (receivedUserid && String(receivedUserid) !== expectedUserid) {
            return new Response("User ID mismatch", { status: 403, headers: SECURITY_HEADERS });
          }
        } catch {
          // ignore empty body
        }

        const nowMs = Date.now();
        const lastTrigger = hookCooldowns.get(expectedData) || 0;
        if (nowMs - lastTrigger >= HOOK_COOLDOWN_MS) {
          if (hookCooldowns.size > 1000) {
            hookCooldowns.clear();
          }
          hookCooldowns.set(expectedData, nowMs);
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
        }

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
