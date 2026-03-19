const express = require('express');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const app = express();
const execFileAsync = promisify(execFile);

// Reuse same Slack app-level token (xapp) for all workspaces of same Slack app
const SHARED_APP_TOKEN = process.env.SLACK_APP_TOKEN;

// Optional: hardcode if you don't want new env
const REDIRECT_URI = process.env.SLACK_REDIRECT_URI || '[https://your-domain.com/slack/oauth](https://your-domain.com/slack/oauth)';

function makeAccountId(teamId) {
  return `launchbased_${String(teamId).toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
}

function escapeHtml(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

app.get('/slack/oauth', async (req, res) => {
  const code = req.query.code;
  // TODO: validate req.query.state against your session/store for CSRF protection

  if (!code) return res.status(400).send('❌ No code provided by Slack.');

  if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET ) {
    return res.status(500).send('❌ Missing SLACK_CLIENT_ID / SLACK_CLIENT_SECRET.');
  }

  if (!SHARED_APP_TOKEN) {
    return res.status(500).send('❌ Missing SLACK_APP_TOKEN (xapp).');
  }

  try {
    // Exchange OAuth code for workspace-specific bot token (xoxb)
    const response = await fetch('[https://slack.com/api/oauth.v2.access](https://slack.com/api/oauth.v2.access)', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI
      })
    });

    const data = await response.json();

    if (!data.ok) {
      return res
        .status(400)
        .send(`<h1>❌ Installation failed</h1><p>${escapeHtml(data.error)}</p>`);
    }

    const teamId = data.team?.id;
    const teamName = data.team?.name || 'Slack Workspace';
    const botToken = data.access_token; // xoxb for THIS workspace
    const accountId = makeAccountId(teamId);

    if (!teamId || !botToken) {
      return res.status(500).send('❌ Slack response missing team/token.');
    }

    // 1) Register/update this workspace as a Slack account in OpenClaw
    await execFileAsync('openclaw', [
      'channels',
      'add',
      '--channel',
      'slack',
      '--account',
      accountId,
      '--name',
      `LaunchBased ${teamName}`,
      '--bot-token',
      botToken,
      '--app-token',
      SHARED_APP_TOKEN
    ]);

    // 2) Bind to main agent (same bot behavior everywhere)
    await execFileAsync('openclaw', [
      'agents',
      'bind',
      '--agent',
      'main',
      '--bind',
      `slack:${accountId}`
    ]);

    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:40px;">
        <h1 style="color:green;">✅ Slack Bot Installed + Connected</h1>
        <p><b>${escapeHtml(teamName)}</b> is now registered in OpenClaw.</p>
        <p>Account ID: <code>${escapeHtml(accountId)}</code></p>
        <p>You can close this window.</p>
      </div>
    `);

  } catch (err) {
    console.error('OAuth callback error:', err);
    return res.status(500).send('❌ Server error occurred.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
