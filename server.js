const express = require('express');
const app = express();

// This is the endpoint Slack will redirect to
app.get('/slack/oauth', async (req, res) => {
  const code = req.query.code;
  
  if (!code) {
    return res.send('❌ No code provided by Slack.');
  }

  try {
    // We send the code and our hidden secrets back to Slack
    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code: code
      })
    });

    const data = await response.json();

    if (data.ok) {
      // SUCCESS! 
      // Note: data.access_token contains the Bot Token for this specific workspace.
      // In the future, you will save that token to a database here.
      
      res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: green;">✅ Slack Bot Installed Successfully!</h1>
          <p>The OAuth flow is complete. You can close this window.</p>
        </div>
      `);
    } else {
      res.send(`<h1 style="color: red;">❌ Installation Failed</h1><p>Error: ${data.error}</p>`);
    }
  } catch (error) {
    res.send('❌ Server error occurred.');
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
