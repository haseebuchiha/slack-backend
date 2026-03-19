const express = require('express');

const app = express();

// ---------- Required env ----------
const {
  SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET,
  SLACK_REDIRECT_URI, // must exactly match Slack app redirect URL
  SLACK_APP_TOKEN, // xapp-... (same app token reused for all workspaces)
  OPENCLAW_GATEWAY_URL, // e.g. https://your-openclaw-host:18789
  OPENCLAW_GATEWAY_TOKEN // gateway auth token
} = process.env;

function required(name, value) {
  if (!value) throw new Error(`Missing env: ${name}`);
}

function escapeHtml(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function makeAccountId(teamId) {
  return `launchbased_${String(teamId).toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
}

async function slackOAuthExchange(code) {
  const resp = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
      redirect_uri: SLACK_REDIRECT_URI
    })
  });
  return resp.json();
}

async function gatewayConfigGet() {
  const r = await fetch(`${OPENCLAW_GATEWAY_URL}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`
    },
    body: JSON.stringify({
      id: `cfg-get-${Date.now()}`,
      method: 'config.get',
      params: {}
    })
  });
  const j = await r.json();
  if (j.error) throw new Error(`config.get failed: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

async function gatewayConfigPatch(baseHash, patch, note) {
  const r = await fetch(`${OPENCLAW_GATEWAY_URL}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`
    },
    body: JSON.stringify({
      id: `cfg-patch-${Date.now()}`,
      method: 'config.patch',
      params: {
        raw: JSON.stringify(patch),
        baseHash,
        note
      }
    })
  });
  const j = await r.json();
  if (j.error) throw new Error(`config.patch failed: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

app.get('/slack/oauth', async (req, res) => {
  try {
    required('SLACK_CLIENT_ID', SLACK_CLIENT_ID);
    required('SLACK_CLIENT_SECRET', SLACK_CLIENT_SECRET);
    required('SLACK_REDIRECT_URI', SLACK_REDIRECT_URI);
    required('SLACK_APP_TOKEN', SLACK_APP_TOKEN);
    required('OPENCLAW_GATEWAY_URL', OPENCLAW_GATEWAY_URL);
    required('OPENCLAW_GATEWAY_TOKEN', OPENCLAW_GATEWAY_TOKEN);

    const code = req.query.code;
    if (!code) return res.status(400).send('❌ No code provided by Slack.');

    // 1) Exchange Slack OAuth code
    const data = await slackOAuthExchange(code);

    if (!data.ok) {
      return res
        .status(400)
        .send(`<h1>❌ Slack OAuth failed</h1><p>${escapeHtml(data.error || 'unknown_error')}</p>`);
    }

    const teamId = data.team?.id;
    const teamName = data.team?.name || 'Slack Workspace';
    const botToken = data.access_token; // xoxb for this workspace
    const accountId = makeAccountId(teamId);

    if (!teamId || !botToken) {
      return res.status(500).send('❌ Slack response missing team.id/access_token.');
    }

    // 2) Read current config
    const cfg = await gatewayConfigGet();
    const baseHash = cfg.hash;

    // 3) Patch: add Slack account + binding to main
    const patch = {
      channels: {
        slack: {
          accounts: {
            [accountId]: {
              name: `LaunchBased ${teamName}`,
              enabled: true,
              botToken,
              appToken: SLACK_APP_TOKEN,
              userTokenReadOnly: true,
              nativeStreaming: true,
              streaming: 'partial'
            }
          }
        }
      },
      bindings: [
        {
          agentId: 'main',
          match: { channel: 'slack', accountId }
        }
      ]
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
    console.error('OAuth callback error:', err);
    return res
      .status(500)
      .send(`❌ Server error: ${escapeHtml(err.message || String(err))}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
