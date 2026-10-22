// Cloudflare Worker: Telegram bot to start/stop a GitHub Codespace.
//
// Vars:    CODESPACE_NAME, ALLOWED_CHAT_IDS, GH_REPO
// Secrets: TELEGRAM_BOT_TOKEN, GITHUB_TOKEN, WEBHOOK_SECRET
//
// Commands (Telegram):
//   /on     -> POST https://api.github.com/user/codespaces/{name}/start
//   /off    -> POST https://api.github.com/user/codespaces/{name}/stop
//   /status -> GET  https://api.github.com/user/codespaces/{name}

function authHeaders(env) {
  return {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cs-switch-worker",
  };
}

async function gh(env, path, method = "GET") {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: authHeaders(env),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { ok: r.ok, status: r.status, data };
}

async function csState(env) {
  const r = await gh(env, `/user/codespaces/${env.CODESPACE_NAME}`);
  if (r.ok && r.data && r.data.state) return r.data.state;
  const u = await gh(env, `/user/codespaces`);
  if (u.ok && u.data && Array.isArray(u.data.codespaces)) {
    const found = u.data.codespaces.find(c => c.name === env.CODESPACE_NAME);
    if (found) return found.state;
  }
  return "unknown";
}

async function tgSend(env, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.error("tgSend failed", e);
  }
}

// Fail-closed secret_token check.
//
// Telegram sends the secret back in the `X-Telegram-Bot-Api-Secret-Token`
// header on every update. The expected value comes from the WEBHOOK_SECRET
// worker secret (falling back to the `secret_token` query param that was
// used when the webhook was registered).
//
// If no expected secret is configured the worker MUST reject the request:
// an unauthenticated /webhook would otherwise let anyone start/stop the
// codespace.
function checkSecret(request, url, env) {
  const expected = env.WEBHOOK_SECRET || url.searchParams.get("secret_token");
  if (!expected) {
    console.error("WEBHOOK_SECRET not configured - rejecting request");
    return { ok: false, status: 500, reason: "no secret configured" };
  }
  const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (got !== expected) {
    return { ok: false, status: 403, reason: "bad secret_token" };
  }
  return { ok: true };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const codespace = env.CODESPACE_NAME;
    const allowed = (env.ALLOWED_CHAT_IDS || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(`cs-switch-worker alive; codespace=${codespace}`, { status: 200 });
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("not found", { status: 404 });
    }

    // secret_token check (header sent by Telegram, value from WEBHOOK_SECRET)
    const secret = checkSecret(request, url, env);
    if (!secret.ok) {
      return new Response(secret.reason === "no secret configured" ? "server misconfigured" : "forbidden",
        { status: secret.status });
    }

    let update;
    try { update = await request.json(); } catch { return new Response("bad json", { status: 400 }); }

    const msg = update.message || update.edited_message;
    if (!msg || !msg.chat) return new Response("ok", { status: 200 });

    const chatId = String(msg.chat.id);
    if (allowed.length && !allowed.includes(chatId)) {
      await tgSend(env, chatId, "Not authorized.");
      return new Response("ok", { status: 200 });
    }

    const raw = (msg.text || "").trim();
    const cmd = raw.split(/\s+/)[0].toLowerCase().replace(/^\//, "");

    try {
      if (cmd === "on" || cmd === "start") {
        const st = await csState(env);
        if (["Available", "Running", "Starting"].includes(st)) {
          await tgSend(env, chatId, `Codespace is already ${st}.`);
        } else {
          const r = await gh(env, `/user/codespaces/${codespace}/start`, "POST");
          await tgSend(env, chatId, r.ok
            ? `Start requested for ${codespace}. It takes ~1-2 minutes to be ready.`
            : `Failed to start (HTTP ${r.status}).`);
        }
      } else if (cmd === "off" || cmd === "stop") {
        const st = await csState(env);
        if (["Shutdown", "Stopped", "Stopping"].includes(st)) {
          await tgSend(env, chatId, `Codespace is already ${st}.`);
        } else {
          const r = await gh(env, `/user/codespaces/${codespace}/stop`, "POST");
          await tgSend(env, chatId, r.ok
            ? `Stop requested for ${codespace}.`
            : `Failed to stop (HTTP ${r.status}).`);
        }
      } else if (cmd === "status") {
        const st = await csState(env);
        await tgSend(env, chatId, `Codespace ${codespace} state: ${st}`);
      } else {
        await tgSend(env, chatId, "Commands: /on  /off  /status");
      }
    } catch (e) {
      await tgSend(env, chatId, `Error: ${e && e.message ? e.message : e}`);
    }

    return new Response("ok", { status: 200 });
  },
};
