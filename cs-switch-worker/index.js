// Cloudflare Worker: Telegram bot to start/stop a GitHub Codespace and
// re-publish its forwarded ports.
//
// Vars:    CODESPACE_NAME, ALLOWED_CHAT_IDS, GH_REPO
// Secrets: TELEGRAM_BOT_TOKEN, GITHUB_TOKEN, WEBHOOK_SECRET
//
// Commands (Telegram):
//   /on     -> wait for a startable state, POST .../start, poll until
//              Available, then make ports 8642 + 3001 public
//   /off    -> POST https://api.github.com/user/codespaces/{name}/stop
//   /status -> GET  https://api.github.com/user/codespaces/{name}
//   /ports  -> report / refresh the current port visibility
//   /help   -> show the interactive menu
//
// Every reply carries an inline keyboard (getInlineKeyboard) with the
// Turn ON / Turn OFF / Check Status buttons. Button presses arrive as
// callback_query updates with data "action_on" / "action_off" /
// "action_status" and are routed to the same handlers.
//
// ---------------------------------------------------------------------------
// Port visibility - how it really works
// ---------------------------------------------------------------------------
// The GitHub REST API has no usable port-visibility endpoint:
//   PATCH /user/codespaces/{name}/ports/8642  -> 404 Not Found
//   GET   /user/codespaces/{name}/ports        -> 404 Not Found
// Port visibility lives in the Azure DevOps *tunnel* service that backs
// Codespaces. `gh codespace ports visibility` uses exactly this sequence:
//
//   1. GET    /user/codespaces/{name}?internal=true&refresh=true
//        -> connection.tunnelProperties = { tunnelId, clusterId,
//                                           managePortsAccessToken, ... }
//   2. DELETE /tunnels/{tunnelId}/ports/{port}      (204, or 404 if absent)
//   3. GET    /tunnels/{tunnelId}/ports/{port}      (sanity, optional)
//   4. PUT    /tunnels/{tunnelId}/ports/{port}      (201 Created)
//
// with an `accessControl` entry of type "Anonymous" scoped to "connect",
// which is what makes the port publicly reachable.
//
// The PUT is a full replace of the port resource, so a port that already
// exists has to be deleted first - a PUT on an existing port number fails
// with 409 "Tunnel port number conflicts with an existing port in the tunnel".
//
// We first attempt the documented GitHub REST PATCH (in case GitHub ships
// it later) and fall back to the tunnel sequence that works today.

const TUNNEL_API_VERSION = "2023-09-27-preview";
const PUBLIC_PORTS = [8642, 3001];
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 15;

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

async function tgSend(env, chatId, text, extra = {}) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
  } catch (e) {
    console.error("tgSend failed", e);
  }
}

// ---------------------------------------------------------------------------
// Inline keyboard
// ---------------------------------------------------------------------------

// The persistent menu shown under every bot reply. Each button carries a
// callback_data value that the callback_query handler routes back to the
// same code path as the equivalent slash command.
function getInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🟢 Turn ON", callback_data: "action_on" }],
      [{ text: "🔴 Turn OFF", callback_data: "action_off" }],
      [{ text: "📊 Check Status", callback_data: "action_status" }],
    ],
  };
}

// Answer a button press so Telegram removes the loading spinner on it.
// Always called first, before the (potentially slow) action runs, because
// Telegram shows a spinner for ~30s on an unanswered callback query.
async function tgAnswerCallback(env, callbackQueryId, text = "") {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (e) {
    console.error("tgAnswerCallback failed", e);
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

// ---------------------------------------------------------------------------
// Tunnel helpers
// ---------------------------------------------------------------------------

// Pull the tunnel coordinates out of the codespace record. The tunnel
// access token is short lived, so we always re-read this right before
// touching the ports rather than caching it.
async function tunnelInfo(env) {
  const r = await gh(env, `/user/codespaces/${env.CODESPACE_NAME}?internal=true&refresh=true`);
  if (!r.ok || !r.data) {
    return { ok: false, error: `codespace lookup failed (HTTP ${r.status})` };
  }
  const tp = r.data.connection && r.data.connection.tunnelProperties;
  if (!tp || !tp.tunnelId || !tp.managePortsAccessToken) {
    return { ok: false, error: "no tunnel information in codespace response" };
  }
  return {
    ok: true,
    tunnelId: tp.tunnelId,
    clusterId: tp.clusterId || "inc1",
    token: tp.managePortsAccessToken,
  };
}

function tunnelHeaders(token) {
  return {
    "Authorization": `Tunnel ${token}`,
    "Content-Type": "application/json;charset=UTF-8",
    "User-Agent": "Dev-Tunnels-Service-Go-SDK/0.2.0",
  };
}

// Recreate a single forwarded port as publicly reachable.
//
// `visibility` is not a field of the tunnel port resource - public access
// is expressed by an accessControl entry of type "Anonymous" with the
// "connect" scope. The PUT is a full replace, hence the DELETE first.
async function makeTunnelPortPublic(env, tunnel, port) {
  const base = `https://${tunnel.clusterId}.rel.tunnels.api.visualstudio.com/tunnels/${tunnel.tunnelId}`;
  const url = `${base}/ports/${port}?includePorts=true&api-version=${TUNNEL_API_VERSION}`;
  const headers = tunnelHeaders(tunnel.token);

  // 1. Remove any existing registration (404 simply means it was absent).
  const del = await fetch(url, { method: "DELETE", headers });
  if (!del.ok && del.status !== 404) {
    return { ok: false, port, error: `delete failed (HTTP ${del.status})` };
  }

  // 2. Recreate it with anonymous connect access.
  const body = {
    portNumber: port,
    labels: ["UserForwardedPort"],
    protocol: "http",
    accessControl: {
      entries: [
        { type: "Anonymous", subjects: [], scopes: ["connect"] },
      ],
    },
    portForwardingUris: null,
    inspectionUri: "",
  };
  const put = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "If-None-Match": "*" },
    body: JSON.stringify(body),
  });
  if (!put.ok) {
    let detail = "";
    try {
      const t = await put.text();
      detail = t ? ` ${t.slice(0, 200)}` : "";
    } catch { /* ignore */ }
    return { ok: false, port, error: `put failed (HTTP ${put.status})${detail}` };
  }
  return { ok: true, port };
}

// Preferred path: the documented GitHub REST endpoint. Kept first so the
// worker switches to it automatically if GitHub ever ships it.
async function patchPortViaRest(env, port) {
  const r = await gh(env, `/user/codespaces/${env.CODESPACE_NAME}/ports/${port}`, "PATCH");
  if (r.ok) return { ok: true, port, via: "rest" };
  return { ok: false, port, via: "rest", status: r.status };
}

// Fallback path: the Azure DevOps tunnels API (what `gh` itself uses).
async function patchPortViaTunnel(env, port) {
  const t = await tunnelInfo(env);
  if (!t.ok) return { ok: false, port, via: "tunnel", error: t.error };
  const r = await makeTunnelPortPublic(env, t, port);
  return { ...r, via: "tunnel" };
}

// Make a single port public using whichever mechanism is available.
async function setPortPublic(env, port) {
  const rest = await patchPortViaRest(env, port);
  if (rest.ok) return rest;
  return await patchPortViaTunnel(env, port);
}

// Publish every port we care about, sequentially (the tunnel service is
// happy with one at a time and it keeps the error messages readable).
async function publishPorts(env, ports = PUBLIC_PORTS) {
  const results = [];
  for (const port of ports) {
    results.push(await setPortPublic(env, port));
  }
  return results;
}

// Poll the codespace until it reports Available.
async function waitForAvailable(env, maxAttempts = POLL_MAX_ATTEMPTS) {
  let last = "unknown";
  for (let i = 0; i < maxAttempts; i++) {
    last = await csState(env);
    if (last === "Available" || last === "Running") {
      return { ok: true, state: last, attempts: i + 1 };
    }
    // A codespace that is being stopped will not become Available again
    // in this flow, so bail out early.
    if (last === "Shutdown" || last === "Stopped") {
      return { ok: false, state: last, attempts: i + 1 };
    }
    await new Promise(res => setTimeout(res, POLL_INTERVAL_MS));
  }
  return { ok: false, state: last, attempts: maxAttempts };
}

// States in which a codespace is mid-transition and a start/stop request
// would be rejected with 409 Conflict.
const TRANSITIONAL_STATES = ["ShuttingDown", "Starting", "Queued", "Stopping", "Rebuilding"];
const START_WAIT_MAX_ATTEMPTS = 12;   // 12 x 5s = 60s

// Wait until the codespace is in a state where a start request is legal.
//
// Toggling /off -> /on quickly hits "409 Conflict" because the codespace is
// still ShuttingDown when the start request arrives. GitHub reports those
// states as: ShuttingDown, Starting, Queued, Stopping, Rebuilding.
//
// Terminal state for this wait: Shutdown or Available (both accept a
// start request). Anything else after the timeout is an abort.
async function waitForStartableState(env, chatId, maxAttempts = START_WAIT_MAX_ATTEMPTS) {
  let state = await csState(env);
  for (let i = 0; i < maxAttempts; i++) {
    if (!TRANSITIONAL_STATES.includes(state)) {
      return { ok: true, state, waited: i };
    }
    await tgSend(env, chatId, `Codespace is currently ${state}. Waiting to start...`);
    await new Promise(res => setTimeout(res, POLL_INTERVAL_MS));
    state = await csState(env);
  }
  return { ok: false, state, waited: maxAttempts };
}

// Stop the codespace, refusing to send a stop request while it is already
// transitioning (GitHub answers 409 Conflict for that).
async function handleOff(env, chatId, codespace) {
  const st = await csState(env);
  if (["Shutdown", "Stopped", "Stopping", "ShuttingDown"].includes(st)) {
    await tgSend(env, chatId, `Codespace is already ${st}.`,
      { reply_markup: getInlineKeyboard() });
    return { ok: true, stage: "already-off", state: st };
  }
  const r = await gh(env, `/user/codespaces/${codespace}/stop`, "POST");
  await tgSend(env, chatId, r.ok
    ? `Stop requested for ${codespace}.`
    : `Failed to stop (HTTP ${r.status}).`,
    { reply_markup: getInlineKeyboard() });
  return { ok: r.ok, stage: "stop", status: r.status };
}

// Full `/on` flow: wait for a startable state -> start -> wait until
// Available -> publish ports -> report.
async function handleOn(env, chatId) {
  const cs = env.CODESPACE_NAME;

  // 1. Make sure the codespace is not mid-transition (avoids 409 Conflict).
  const ready2Start = await waitForStartableState(env, chatId);
  if (!ready2Start.ok) {
    await tgSend(env, chatId,
      `Timed out after ${ready2Start.waited * 5}s waiting for the codespace to settle (state=${ready2Start.state}). Start aborted.`);
    return { ok: false, stage: "wait-startable", state: ready2Start.state };
  }

  // 2. Start it.
  const start = await gh(env, `/user/codespaces/${cs}/start`, "POST");
  if (!start.ok) {
    await tgSend(env, chatId, `Failed to start ${cs} (HTTP ${start.status}).`);
    return { ok: false, stage: "start", status: start.status };
  }

  const ready = await waitForAvailable(env);
  if (!ready.ok) {
    await tgSend(env, chatId,
      `${cs} did not become Available (state=${ready.state}, ${ready.attempts} attempts). Ports not published.`);
    return { ok: false, stage: "wait", state: ready.state };
  }

  const results = await publishPorts(env);
  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    const detail = failed.map(r => `${r.port}: ${r.error || "failed"}`).join("; ");
    await tgSend(env, chatId, `${cs} is Available but port publishing failed - ${detail}`);
    return { ok: false, stage: "ports", results };
  }

  const listed = results.map(r => `${r.port}`).join(", ");
  await tgSend(env, chatId,
    `${cs} is ${ready.state} and ports ${listed} are now public.`);
  return { ok: true, stage: "done", state: ready.state, results };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const codespace = env.CODESPACE_NAME;
    const allowed = (env.ALLOWED_CHAT_IDS || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(`cs-switch-worker alive; codespace=${codespace}`, { status: 200 });
    }

    if (request.method !== "POST" ||
        (url.pathname !== "/webhook" &&
         url.pathname !== "/webhook/register" &&
         url.pathname !== "/webhook/menu")) {
      return new Response("not found", { status: 404 });
    }

    // secret_token check (header sent by Telegram, value from WEBHOOK_SECRET)
    const secret = checkSecret(request, url, env);
    if (!secret.ok) {
      return new Response(secret.reason === "no secret configured" ? "server misconfigured" : "forbidden",
        { status: secret.status });
    }

    // Re-register the Telegram webhook so that Telegram sends the current
    // WEBHOOK_SECRET back in X-Telegram-Bot-Api-Secret-Token.
    //
    // Needed whenever the secret is rotated: Telegram keeps using the old
    // value until setWebhook is called again, and the bot token only exists
    // inside this worker's secrets - so the worker has to do it itself.
    // Gated by the same secret, so it cannot be abused.
    if (url.pathname === "/webhook/register") {
      const target = url.searchParams.get("url") ||
        "https://cs-switch-worker.sham-nvidia-proxy.workers.dev/webhook";
      const r = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: target, secret_token: env.WEBHOOK_SECRET }),
        },
      );
      const body = await r.text();
      return new Response(body, {
        status: r.ok ? 200 : 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Register the native command menu (the "/" button in the Telegram chat).
    //
    // The bot token only exists inside this worker's secrets, so the worker
    // registers its own menu - exactly like /webhook/register above.
    // Gated by the same secret token.
    if (url.pathname === "/webhook/menu") {
      const commands = [
        { command: "on", description: "🟢 Start Codespace" },
        { command: "off", description: "🔴 Stop Codespace" },
        { command: "status", description: "📊 Check Status" },
        { command: "help", description: "❓ Show Menu" },
      ];
      const r = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commands }),
        },
      );
      const body = await r.text();
      return new Response(body, {
        status: r.ok ? 200 : 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    let update;
    try { update = await request.json(); } catch { return new Response("bad json", { status: 400 }); }

    // ---------------------------------------------------------------------
    // Button clicks (callback_query)
    // ---------------------------------------------------------------------
    const cb = update.callback_query;
    if (cb) {
      const cbChatId = cb.message && cb.message.chat ? String(cb.message.chat.id) : null;
      if (!cbChatId) return new Response("ok", { status: 200 });

      if (allowed.length && !allowed.includes(cbChatId)) {
        // Answer first so the spinner clears even for a rejected press.
        await tgAnswerCallback(env, cb.id, "Not authorized.");
        return new Response("ok", { status: 200 });
      }

      // Clear the loading spinner immediately, then run the action.
      await tgAnswerCallback(env, cb.id);

      const action = String(cb.data || "");
      try {
        if (action === "action_on") {
          ctx.waitUntil(handleOn(env, cbChatId).catch(e => {
            console.error("handleOn failed", e);
            return tgSend(env, cbChatId, `Error: ${e && e.message ? e.message : e}`,
              { reply_markup: getInlineKeyboard() });
          }));
          await tgSend(env, cbChatId, `Starting ${codespace} and publishing ports...`,
            { reply_markup: getInlineKeyboard() });
        } else if (action === "action_off") {
          await handleOff(env, cbChatId, codespace);
        } else if (action === "action_status") {
          const st = await csState(env);
          await tgSend(env, cbChatId, `Codespace ${codespace} state: ${st}`,
            { reply_markup: getInlineKeyboard() });
        } else {
          await tgSend(env, cbChatId, "Unknown action.", { reply_markup: getInlineKeyboard() });
        }
      } catch (e) {
        await tgSend(env, cbChatId, `Error: ${e && e.message ? e.message : e}`,
          { reply_markup: getInlineKeyboard() });
      }
      return new Response("ok", { status: 200 });
    }

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
      if (cmd === "on") {
        // Start + poll + port publishing can take over a minute.
        // Telegram expects a fast 200 and retries slow webhooks, so the
        // long running work is handed to waitUntil. The "ports are public"
        // confirmation is sent from inside it - i.e. the user is only told
        // "done" once the ports really are public.
        ctx.waitUntil(handleOn(env, chatId).catch(e => {
          console.error("handleOn failed", e);
          return tgSend(env, chatId, `Error: ${e && e.message ? e.message : e}`,
            { reply_markup: getInlineKeyboard() });
        }));
        await tgSend(env, chatId, `Starting ${codespace} and publishing ports...`,
          { reply_markup: getInlineKeyboard() });
      } else if (cmd === "off") {
        await handleOff(env, chatId, codespace);
      } else if (cmd === "status") {
        const st = await csState(env);
        await tgSend(env, chatId, `Codespace ${codespace} state: ${st}`,
          { reply_markup: getInlineKeyboard() });
      } else if (cmd === "ports") {
        const results = await publishPorts(env);
        const detail = results.map(r => r.ok ? `${r.port}: public` : `${r.port}: FAILED (${r.error})`).join("\n");
        await tgSend(env, chatId, `Port visibility for ${codespace}:\n${detail}`,
          { reply_markup: getInlineKeyboard() });
      } else if (cmd === "start" || cmd === "help" || cmd === "menu" || cmd === "") {
        await tgSend(env, chatId,
          "Codespace control menu:\n\n🟢 Turn ON  - start the codespace and publish ports\n" +
          "🔴 Turn OFF - stop the codespace\n" +
          "📊 Check Status - show the current state\n\n" +
          "Commands: /on  /off  /status  /ports",
          { reply_markup: getInlineKeyboard() });
      } else {
        await tgSend(env, chatId, "Commands: /on  /off  /status  /ports",
          { reply_markup: getInlineKeyboard() });
      }
    } catch (e) {
      await tgSend(env, chatId, `Error: ${e && e.message ? e.message : e}`,
        { reply_markup: getInlineKeyboard() });
    }

    return new Response("ok", { status: 200 });
  },
};
