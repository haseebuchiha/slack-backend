const express = require("express");
const WebSocket = require("ws");

const app = express();

// ---------- Required env ----------
const {
  SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET,
  SLACK_REDIRECT_URI, // must exactly match Slack app redirect URL
  SLACK_APP_TOKEN, // xapp-... (same app token reused for all workspaces)
  OPENCLAW_GATEWAY_URL, // ws://... or wss://...
  OPENCLAW_GATEWAY_TOKEN, // gateway auth token
} = process.env;

function required(name, value) {
  if (!value) throw new Error(`Missing env: ${name}`);
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function makeAccountId(teamId) {
  return `launchbased_${String(teamId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")}`;
}

function ensureGatewayUrlLooksRight(url) {
  if (!/^wss?:\/\//i.test(url || "")) {
    throw new Error(
      "OPENCLAW_GATEWAY_URL must be ws:// or wss:// (example: ws://159.203.104.70:18789)"
    );
  }
}

async function slackOAuthExchange(code) {
  const resp = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
      redirect_uri: SLACK_REDIRECT_URI,
    }),
  });

  return resp.json();
}

/**
 * JSON-RPC over WebSocket to OpenClaw gateway.
 */
async function gatewayCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const ws = new WebSocket(OPENCLAW_GATEWAY_URL, {
      headers: {
        Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      },
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      reject(new Error("Gateway WebSocket timeout"));
    }, 25000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ id, method, params }));
    });

    ws.on("message", (buf) => {
      if (settled) return;

      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return; // ignore non-JSON frames
      }

      // ignore unrelated events/messages
      if (!msg || msg.id !== id) return;

      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}

      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        return;
      }

      resolve(msg.result ?? msg);
    });

    ws.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    ws.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("Gateway WebSocket closed before response"));
    });
  });
}

function extractConfigObject(cfgResult) {
  return cfgResult?.config || cfgResult?.value || cfgResult?.parsed || cfgResult?.data || {};
}

async function gatewayConfigGet() {
  return gatewayCall("config.get", {});
}

async function gatewayConfigPatch(baseHash, patch, note) {
  return gatewayCall("config.patch", {
    raw: JSON.stringify(patch),
    baseHash,
    note,
  });
}

app.get("/slack/oauth", async (req, res) => {
  try {
    required("SLACK_CLIENT_ID", SLACK_CLIENT_ID);
    required("SLACK_CLIENT_SECRET", SLACK_CLIENT_SECRET);
    required("SLACK_REDIRECT_URI", SLACK_REDIRECT_URI);
    required("SLACK_APP_TOKEN", SLACK_APP_TOKEN);
    required("OPENCLAW_GATEWAY_URL", OPENCLAW_GATEWAY_URL);
    required("OPENCLAW_GATEWAY_TOKEN", OPENCLAW_GATEWAY_TOKEN);

    ensureGatewayUrlLooksRight(OPENCLAW_GATEWAY_URL);

    const code = req.query.code;
    if (!code) return res.status(400).send("❌ No code provided by Slack.");

    // 1) Exchange Slack OAuth code
    const data = await slackOAuthExchange(code);

    if (!data.ok) {
      return res
        .status(400)
        .send(`<h1>❌ Slack OAuth failed</h1><p>${escapeHtml(data.error || "unknown_error")}</p>`);
    }

    const teamId = data.team?.id;
    const teamName = data.team?.name || "Slack Workspace";
    const botToken = data.access_token; // xoxb for this workspace
    const accountId = makeAccountId(teamId);

    if (!teamId || !botToken) {
      return res.status(500).send("❌ Slack response missing team.id/access_token.");
    }

    // 2) Read current config
    const cfgResult = await gatewayConfigGet();
    const baseHash = cfgResult?.hash;
    if (!baseHash) throw new Error("config.get response missing hash.");

    const currentConfig = extractConfigObject(cfgResult);
    const existingBindings = Array.isArray(currentConfig?.bindings) ? currentConfig.bindings : [];

    // 3) Merge binding safely (do not overwrite old bindings)
    const newBinding = {
      agentId: "main",
      match: { channel: "slack", accountId },
    };

    const alreadyBound = existingBindings.some(
      (b) =>
        b?.agentId === "main" &&
        b?.match?.channel === "slack" &&
        b?.match?.accountId === accountId
    );

    const mergedBindings = alreadyBound ? existingBindings : [...existingBindings, newBinding];

    // 4) Patch account + bindings
    const patch = {
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          accounts: {
            [accountId]: {
              name: `LaunchBased ${teamName}`,
              enabled: true,
              botToken,
              appToken: SLACK_APP_TOKEN,
              userTokenReadOnly: true,
              nativeStreaming: true,
              streaming: "partial",
            },
          },
        },
      },
      bindings: mergedBindings,
    };

    await gatewayConfigPatch(
      baseHash,
      patch,
      `Auto-registered Slack workspace ${teamName} (${teamId}) as account ${accountId} from OAuth callback.`
    );

    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:40px;">
        <h1 style="color:green;">✅ Slack Bot Installed + Connected</h1>
        <p><b>${escapeHtml(teamName)}</b> was registered in OpenClaw.</p>
        <p>Account ID: <code>${escapeHtml(accountId)}</code></p>
        <p>You can close this window.</p>
      </div>
    `);
  } catch (err) {
    console.error("OAuth callback error:", err);
    return res.status(500).send(`❌ Server error: ${escapeHtml(err.message || String(err))}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
