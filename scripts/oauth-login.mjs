import http from "node:http";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const PORT = 51121;
const SCOPES = [
  "email",
  "profile",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "openid",
];

function getConfigDir() {
  return process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode");
}

function getAuthPath() {
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
}

function getAccountsPath() {
  return path.join(getConfigDir(), "antigravity-accounts.json");
}

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthURL(challenge, state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: Buffer.from(JSON.stringify({ verifier: "", projectId: "", _state: state })).toString("base64"),
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${err}`);
  }
  return res.json();
}

async function refreshToken(refreshToken) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${err}`);
  }
  return res.json();
}

async function loadCodeAssist(accessToken) {
  const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.21.9 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36",
      "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
      "Client-Metadata": '{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
    },
    body: JSON.stringify({
      metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
    }),
  });

  if (!res.ok) return null;
  return res.json();
}

async function onboardUser(accessToken, tierId) {
  const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:onboardUser", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.21.9 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36",
      "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
      "Client-Metadata": '{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
    },
    body: JSON.stringify({
      tierId,
      metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
    }),
  });

  if (!res.ok) return null;
  return res.json();
}

function saveCredentials(tokens, managedProjectId) {
  const now = Date.now();
  const expires = now + (tokens.expires_in || 3600) * 1000;

  // Save auth.json
  const authPath = getAuthPath();
  let auth = {};
  try { auth = JSON.parse(fs.readFileSync(authPath, "utf-8")); } catch {}
  auth.google = {
    type: "oauth",
    refresh: `${tokens.refresh_token}||${managedProjectId || ""}`,
    access: tokens.access_token,
    expires,
  };
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));

  // Save antigravity-accounts.json
  const accountsPath = getAccountsPath();
  let accounts = { version: 4, accounts: [], activeIndex: 0, activeIndexByFamily: { claude: 0, gemini: 0 } };
  try { accounts = JSON.parse(fs.readFileSync(accountsPath, "utf-8")); } catch {}

  const existingIdx = accounts.accounts.findIndex((a) => a.refreshToken === tokens.refresh_token);
  const account = {
    refreshToken: tokens.refresh_token,
    managedProjectId: managedProjectId || "",
    addedAt: now,
    lastUsed: 0,
    enabled: true,
    rateLimitResetTimes: {},
    fingerprint: {
      deviceId: crypto.randomUUID(),
      sessionToken: crypto.randomBytes(16).toString("hex"),
      userAgent: "antigravity/1.21.9 darwin/arm64",
      apiClient: "google-cloud-sdk vscode_cloudshelleditor/0.1",
      clientMetadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
      createdAt: now,
    },
  };

  if (existingIdx >= 0) {
    accounts.accounts[existingIdx] = { ...accounts.accounts[existingIdx], ...account };
  } else {
    accounts.accounts.push(account);
  }

  fs.mkdirSync(path.dirname(accountsPath), { recursive: true });
  fs.writeFileSync(accountsPath, JSON.stringify(accounts, null, 2));

  return { authPath, accountsPath };
}

async function resolveManagedProject(accessToken) {
  const payload = await loadCodeAssist(accessToken);
  if (!payload) return "";

  let managedProjectId = "";
  if (typeof payload.cloudaicompanionProject === "string") {
    managedProjectId = payload.cloudaicompanionProject;
  } else if (payload.cloudaicompanionProject?.id) {
    managedProjectId = payload.cloudaicompanionProject.id;
  }

  if (!managedProjectId) {
    const tiers = payload.allowedTiers || [];
    const defaultTier = tiers.find((t) => t.isDefault) || tiers[0];
    const tierId = defaultTier?.id || "free-tier";

    const onboard = await onboardUser(accessToken, tierId);
    if (onboard?.response?.cloudaicompanionProject?.id) {
      managedProjectId = onboard.response.cloudaicompanionProject.id;
    }
  }

  return managedProjectId;
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    execSync(`${cmd} "${url}"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const { verifier, challenge } = generatePKCE();

  const authURL = buildAuthURL(challenge, "");
  const statePayload = { verifier, projectId: "" };
  const stateParam = Buffer.from(JSON.stringify(statePayload)).toString("base64");
  const fullURL = authURL.replace(/state=[^&]+/, `state=${encodeURIComponent(stateParam)}`);

  console.log("\n  Antigravity OAuth Login");
  console.log("  =======================\n");

  const opened = openBrowser(fullURL);

  let code = null;

  // Try callback server if browser opened
  if (opened) {
    console.log("  Browser opened. Authorize with your Google account.");
    console.log("  Waiting for callback on localhost:51121 ...\n");

    code = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        server.close();
        resolve(null);
      }, 30_000);

      const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        if (url.pathname !== "/oauth-callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const c = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Authorization failed</h1><p>You can close this tab.</p>");
          clearTimeout(timeout);
          server.close();
          resolve(null);
          return;
        }

        if (!c) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Missing code</h1>");
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>");
        clearTimeout(timeout);
        server.close();
        resolve(c);
      });

      server.listen(PORT).on("error", () => {
        clearTimeout(timeout);
        resolve(null);
      });
    });
  }

  // Fallback: manual paste
  if (!code) {
    console.log("\n  No browser or callback not received.");
    console.log("  Open this URL on any device (phone, another computer, etc.):\n");
    console.log(`  ${fullURL}\n`);
    console.log("  After authorizing, the page will say 'connection refused'.");
    console.log("  Copy the full URL from the address bar and paste it below.\n");

    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    code = await new Promise((resolve) => {
      rl.question("  Paste the callback URL: ", (answer) => {
        rl.close();
        try {
          const callbackUrl = new URL(answer.trim());
          const c = callbackUrl.searchParams.get("code");
          if (!c) {
            console.error("\n  Error: No 'code' parameter found in the URL.");
            process.exit(1);
          }
          resolve(c);
        } catch {
          console.error("\n  Error: Invalid URL. Make sure you paste the full URL from the browser.");
          process.exit(1);
        }
      });
    });
  }

  console.log("  Exchanging code for tokens...");
  const tokens = await exchangeCode(code, verifier);
  console.log("  Token exchange successful.");

  console.log("  Resolving managed project...");
  const managedProjectId = await resolveManagedProject(tokens.access_token);
  if (managedProjectId) {
    console.log(`  Managed project: ${managedProjectId}`);
  } else {
    console.log("  No managed project found (will use default).");
  }

  const paths = saveCredentials(tokens, managedProjectId);
  console.log(`  Saved credentials to:`);
  console.log(`    ${paths.authPath}`);
  console.log(`    ${paths.accountsPath}`);
  console.log("\n  Done! You can now use Antigravity models:\n");
  console.log("    opencode run \"Hello\" --model=google/antigravity-gemini-3-flash\n");
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exit(1);
});
