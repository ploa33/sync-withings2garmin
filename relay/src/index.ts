/**
 * Universal Stateless Relay for Withings → Garmin Connect Sync
 * Runs on Cloudflare Workers (100% serverless, zero database).
 *
 * Capabilities:
 *  1. /register  - Validates GitHub Actions OIDC token, returns signed state + webhook URL.
 *  2. /oauth     - Withings OAuth callback: automatically triggers sync.yml via GitHub App.
 *  3. /hook      - Webhook endpoint for Withings real-time weigh-in notifications.
 */

export interface Env {
  GH_APP_ID: string;
  GH_APP_PRIVATE_KEY: string;
  HMAC_SECRET: string;
  GH_APP_SLUG?: string;
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
    exp: now + 600, // 10 minutes max
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
  aud: string;
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
  } catch (err) {
    console.error("Error obtaining installation token:", err);
    return null;
  }
}

async function triggerWorkflowDispatch(
  token: string,
  repo: string,
  inputs?: Record<string, string>
): Promise<boolean> {
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

function renderSuccessPage(repo: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Withings → Garmin Sync Authorized</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; max-width: 480px; width: 100%; padding: 32px; text-align: center; }
    h1 { color: #f0f6fc; font-size: 22px; margin-bottom: 12px; }
    p { font-size: 14px; line-height: 1.6; color: #8b949e; margin-bottom: 24px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 600; margin-bottom: 20px; background: rgba(46, 164, 79, 0.15); color: #2ea44f; border: 1px solid rgba(46, 164, 79, 0.4); }
    .btn { display: inline-block; padding: 12px 20px; font-size: 15px; font-weight: 600; color: #fff; background: #238636; border-radius: 8px; text-decoration: none; transition: background 0.2s; }
    .btn:hover { background: #2ea44f; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 48px; margin-bottom: 16px;">⚖️</div>
    <div class="badge">● Authorization Complete</div>
    <h1>Sync Launched Automatically!</h1>
    <p>Withings authorization succeeded. The relay has automatically triggered your sync workflow on GitHub Actions. You can now close this tab.</p>
    <a class="btn" href="https://github.com/${repo}/actions" target="_blank">View Workflow on GitHub →</a>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function renderManualFallbackPage(code: string, repo: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Withings Authorization Code</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; max-width: 500px; width: 100%; padding: 32px; text-align: center; }
    h1 { color: #f0f6fc; font-size: 22px; margin-bottom: 12px; }
    p { font-size: 14px; line-height: 1.6; color: #8b949e; margin-bottom: 20px; }
    .code-box { background: #0d1117; border: 1px solid #388bfd; border-radius: 8px; padding: 12px; font-family: monospace; font-size: 16px; color: #58a6ff; word-break: break-all; margin-bottom: 16px; }
    .btn { display: inline-block; width: 100%; padding: 12px 20px; font-size: 15px; font-weight: 600; color: #fff; background: #238636; border-radius: 8px; border: none; cursor: pointer; text-decoration: none; margin-bottom: 12px; }
    .btn:hover { background: #2ea44f; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 48px; margin-bottom: 16px;">📋</div>
    <h1>Your Authorization Code</h1>
    <p>Copy the code below, open your GitHub Actions workflow, and paste it into the <code>withings_code</code> field:</p>
    <div class="code-box" id="code-val">${code}</div>
    <button class="btn" id="copy-btn" onclick="copy()">📋 Copy Code to Clipboard</button>
    ${repo ? `<a class="btn" style="background: #21262d; border: 1px solid #30363d;" href="https://github.com/${repo}/actions/workflows/sync.yml" target="_blank">Open Run workflow panel →</a>` : ""}
  </div>
  <script>
    function copy() {
      navigator.clipboard.writeText("${code}").then(() => {
        const btn = document.getElementById('copy-btn');
        btn.innerText = '✅ Code Copied!';
      });
    }
  </script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ── Main Worker Export ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── 1. Webhook endpoint: /hook ─────────────────────────────────────────
    if (url.pathname === "/hook") {
      // Withings validation probe (HEAD or GET)
      if (request.method === "HEAD" || request.method === "GET") {
        return new Response("OK", { status: 200 });
      }

      // Withings weigh-in notification (POST)
      if (request.method === "POST") {
        const repo = url.searchParams.get("r");
        const expectedUserid = url.searchParams.get("u");
        const sig = url.searchParams.get("s");

        if (!repo || !expectedUserid || !sig) {
          return new Response("Missing parameters", { status: 400 });
        }

        // Verify HMAC signature
        const expectedData = `${repo}:${expectedUserid}`;
        const isValid = await verifyHmac(env.HMAC_SECRET, expectedData, sig);
        if (!isValid) {
          return new Response("Invalid signature", { status: 403 });
        }

        // Parse Withings body to verify userid match
        try {
          const formData = await request.formData();
          const receivedUserid = formData.get("userid");
          if (receivedUserid && String(receivedUserid) !== expectedUserid) {
            return new Response("User ID mismatch", { status: 403 });
          }
        } catch {
          // ignore parsing error if empty
        }

        // Respond 200 OK immediately to Withings
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

        return new Response("OK", { status: 200 });
      }

      return new Response("Method Not Allowed", { status: 405 });
    }

    // ── 2. Register endpoint: POST /register ────────────────────────────────
    if (url.pathname === "/register" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization") || "";
      const oidcToken = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (!oidcToken) {
        return new Response(JSON.stringify({ error: "Missing OIDC token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const claims = await verifyGitHubOidcToken(oidcToken);
      if (!claims) {
        return new Response(JSON.stringify({ error: "Invalid OIDC token" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }

      const repo = claims.repository;
      const [owner, name] = repo.split("/");
      const creds = await getInstallationAccessToken(env, owner, name);
      const installed = creds?.installed ?? false;

      // Generate signed state for OAuth (valid 15 minutes)
      const exp = Math.floor(Date.now() / 1000) + 900;
      const stateData = `${repo}:${exp}`;
      const stateSig = await signHmac(env.HMAC_SECRET, stateData);
      const state = `${btoa(stateData)}.${stateSig}`;

      // If Withings userid is provided (Run 2), generate signed webhook URL
      let webhookUrl: string | null = null;
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        // empty body
      }

      if (body.withings_userid) {
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
          app_slug: env.GH_APP_SLUG || "withings-to-garmin-sync",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // ── 3. OAuth callback endpoint: GET /oauth ─────────────────────────────
    if (url.pathname === "/oauth" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        return new Response(`Withings authorization denied: ${error}`, { status: 400 });
      }
      if (!code || !state) {
        return new Response("Missing code or state", { status: 400 });
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
        return new Response("Invalid or forged state parameter", { status: 403 });
      }

      const [repo, expStr] = stateData.split(":");
      const exp = parseInt(expStr || "0", 10);
      if (exp < Math.floor(Date.now() / 1000)) {
        return new Response("Authorization link expired. Please run the workflow again.", { status: 400 });
      }

      const [owner, name] = (repo || "").split("/");
      if (!owner || !name) {
        return renderManualFallbackPage(code, "");
      }

      // Check GitHub App installation
      const creds = await getInstallationAccessToken(env, owner, name);
      if (!creds || !creds.installed) {
        // App not installed: display code so user can paste manually
        return renderManualFallbackPage(code, repo);
      }

      // Trigger sync.yml with withings_code
      const dispatched = await triggerWorkflowDispatch(creds.token, repo, {
        withings_code: code,
      });

      if (dispatched) {
        return renderSuccessPage(repo);
      } else {
        return renderManualFallbackPage(code, repo);
      }
    }

    // Default 404
    return new Response("Not Found", { status: 404 });
  },
};
