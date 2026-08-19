const express = require('express');
const cron = require('node-cron');
const { syncInventory } = require('./modules/inventorySync');
const { importOrders } = require('./modules/orderImport');
const { handleFulfillmentWebhook } = require('./modules/trackingExport');
const { getLogs, addLog } = require('./logger');
const crypto = require('crypto');

const app = express();
app.use(express.raw({ type: 'application/json' }));

const INTERVAL = parseInt(process.env.SYNC_INTERVAL_MINUTES || '30');

// --- Auto-register Shopify webhook on startup ---
async function registerWebhook() {
  try {
    const res = await fetch(`https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/webhooks.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN
      },
      body: JSON.stringify({ webhook: {
        topic: 'inventory_shipments/create',
        address: `https://tradebyte-bridge-production.up.railway.app/webhooks/fulfillment-created`,
        format: 'json'
      }})
    });
    const json = await res.json();
    if (json.webhook) {
      console.log(`✅ Webhook registered: ID ${json.webhook.id}, topic: ${json.webhook.topic}`);
    } else if (json.errors) {
      // Already exists = not a real error
      console.log('ℹ️ Webhook registration response:', JSON.stringify(json));
    }
  } catch (err) {
    console.error('❌ Webhook registration failed:', err.message);
  }
}

// --- Cron Jobs ---
cron.schedule(`*/${INTERVAL} * * * *`, async () => {
  await syncInventory();
  await importOrders();
});

// --- Webhook: Fulfillment Created ---
app.post('/webhooks/fulfillment-created', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const digest = crypto.createHmac('sha256', secret).update(req.body).digest('base64');
  if (digest !== hmac) {
    addLog({ module: 'tracking_export', status: 'error', message: 'Invalid webhook HMAC - unauthorized request' });
    return res.status(401).send('Unauthorized');
  }
  const payload = JSON.parse(req.body);
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

app.listen(process.env.PORT || 3000, async () => {
  console.log('Tradebyte bridge running');
  await registerWebhook();
});
