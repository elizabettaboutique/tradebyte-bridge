const fs = require('fs');
const { addLog } = require('../logger');

const TOKEN_FILE = '/tmp/shopify_token.json'; // Railway ephemeral storage

async function generateNewToken() {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;

  try {
    const res = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials'
        })
      }
    );

    const json = await res.json();

    if (!json.access_token) {
      throw new Error(`Token generation failed: ${JSON.stringify(json)}`);
    }

    // Store token with expiry time (expire 1 hour early as safety buffer)
    const expiresAt = Date.now() + (23 * 60 * 60 * 1000); // 23 hours from now
    const tokenData = {
      access_token: json.access_token,
      expires_at: expiresAt
    };

    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData));
    process.env.SHOPIFY_ADMIN_API_TOKEN = json.access_token;

    addLog({
      module: 'token_manager',
      status: 'success',
      message: 'Shopify access token refreshed successfully',
      meta: { expires_at: new Date(expiresAt).toISOString() }
    });

    return json.access_token;
  } catch (err) {
    addLog({
      module: 'token_manager',
      status: 'error',
      message: `Token generation failed: ${err.message}`
    });
    throw err;
  }
}

async function getValidToken() {
  try {
    // Check if we have a stored token that's still valid
    if (fs.existsSync(TOKEN_FILE)) {
      const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      const timeUntilExpiry = tokenData.expires_at - Date.now();

      // Refresh if less than 2 hours remaining
      if (timeUntilExpiry > 2 * 60 * 60 * 1000) {
        process.env.SHOPIFY_ADMIN_API_TOKEN = tokenData.access_token;
        return tokenData.access_token;
      }
    }
  } catch (err) {
    // Token file missing or corrupt — generate fresh
  }

  return await generateNewToken();
}

module.exports = { getValidToken, generateNewToken };
