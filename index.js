const express = require('express');
const cron = require('node-cron');
const { syncInventory } = require('./modules/inventorySync');
const { importOrders } = require('./modules/orderImport');
const { handleFulfillmentWebhook } = require('./modules/trackingExport');
const { getLogs, addLog } = require('./logger');
const crypto = require('crypto');

const app = express();
app.use(express.raw({ type: 'application/json' }));

const { getValidToken, generateNewToken } = require('./modules/tokenManager');

async function registerWebhooks() {
  const SHOPIFY_URL = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/graphql.json`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN
  };

  try {
    const checkRes = await fetch(SHOPIFY_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: `{
        webhookSubscriptions(first: 10, topics: FULFILLMENTS_UPDATE) {
          edges { node { id callbackUrl } }
        }
      }` })
    });
    const checkJson = await checkRes.json();
    const existing = checkJson.data?.webhookSubscriptions?.edges || [];
    const alreadyRegistered = existing.some(e =>
      e.node.callbackUrl.includes('/webhooks/fulfillment-created')
    );
    if (alreadyRegistered) {
      addLog({ module: 'webhooks', status: 'info', message: 'Webhook already registered, skipping' });
      return;
    }
  } catch (err) {
    addLog({ module: 'webhooks', status: 'error', message: `Webhook check failed: ${err.message}` });
    return;
  }

  try {
    const res = await fetch(SHOPIFY_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: `
        mutation {
          webhookSubscriptionCreate(
            topic: FULFILLMENTS_UPDATE,
            webhookSubscription: {
              format: JSON,
              callbackUrl: "${process.env.RAILWAY_PUBLIC_URL}/webhooks/fulfillment-created"
            }
          ) {
            userErrors { field message }
            webhookSubscription { id }
          }
        }
      ` })
    });
    const json = await res.json();
    addLog({ module: 'webhooks', status: 'info', message: 'Webhook registration result', meta: JSON.stringify(json) });
  } catch (err) {
    addLog({ module: 'webhooks', status: 'error', message: `Webhook registration failed: ${err.message}` });
  }
}

generateNewToken().then(async () => {
  console.log('Initial token generated');
  await registerWebhooks();
}).catch(console.error);

cron.schedule('0 */22 * * *', async () => {
  await generateNewToken();
});

cron.schedule('* * * * *', async () => {
  await getValidToken();
  await syncInventory();
  await importOrders();
});

// --- Webhook: Fulfillment Created/Updated ---
app.post('/webhooks/fulfillment-created', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
  const digest = crypto.createHmac('sha256', secret).update(body).digest('base64');



  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))) {
    addLog({ module: 'tracking_export', status: 'error', message: 'Invalid webhook HMAC - unauthorized request' });
    return res.status(401).send('Unauthorized');
  }

  const payload = JSON.parse(body);
  res.status(200).send('OK');
  await handleFulfillmentWebhook(payload);
});

// --- Manual Triggers ---
app.post('/sync/inventory', async (req, res) => {
  res.json({ triggered: true });
  await syncInventory();
});

app.post('/sync/orders', async (req, res) => {
  res.json({ triggered: true });
  await importOrders();
});

// --- Logs ---
app.get('/logs', (req, res) => {
  const { module, status } = req.query;
  let logs = getLogs();
  if (module) logs = logs.filter(l => l.module === module);
  if (status) logs = logs.filter(l => l.status === status);
  res.json(logs);
});

// --- Health ---
app.get('/health', (req, res) => {
  const logs = getLogs();
  const last24h = Date.now() - 86400000;
  const recent = logs.filter(l => new Date(l.timestamp).getTime() > last24h);
  res.json({
    status: 'ok',
    modules: ['inventory_sync', 'order_import', 'tracking_export'].map(m => ({
      module: m,
      successes: recent.filter(l => l.module === m && l.status === 'success').length,
      errors: recent.filter(l => l.module === m && l.status === 'error').length,
      last_run: recent.filter(l => l.module === m).at(0)?.timestamp || null
    }))
  });
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Tradebyte bridge running');
});
