const { addLog } = require('../logger');

let lastTokenCheck = null;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check every hour

async function verifyShopifyToken() {
  // Skip if checked recently
  if (lastTokenCheck && Date.now() - lastTokenCheck < CHECK_INTERVAL_MS) return;
  lastTokenCheck = Date.now();

  try {
    const res = await fetch(
      `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/shop.json`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN
        }
      }
    );

    if (res.status === 401) {
      addLog({
        module: 'token_manager',
        status: 'error',
        message: '🚨 Shopify API token is invalid or expired — inventory sync and order import will fail until token is rotated in Railway env vars'
      });
      // Optionally send an alert email/webhook here
      return false;
    }

    addLog({
      module: 'token_manager',
      status: 'success',
      message: 'Shopify API token verified OK'
    });
    return true;
  } catch (err) {
    addLog({
      module: 'token_manager',
      status: 'error',
      message: `Token check failed: ${err.message}`
    });
    return false;
  }
}

module.exports = { verifyShopifyToken };
