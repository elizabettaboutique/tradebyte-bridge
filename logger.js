const logs = [];
const MAX = 500;

const SHOPIFY_URL = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/graphql.json`;

async function persistToShopify(entry) {
  try {
    const mutation = `
      mutation {
        metaobjectCreate(metaobject: {
          type: "tradebyte_log",
          fields: [
            { key: "module", value: ${JSON.stringify(entry.module)} },
            { key: "status", value: ${JSON.stringify(entry.status)} },
            { key: "message", value: ${JSON.stringify(entry.message)} },
            { key: "metadata", value: ${JSON.stringify(JSON.stringify(entry.meta || {}))} },
            { key: "timestamp", value: ${JSON.stringify(entry.timestamp)} }
          ]
        }) {
          metaobject { id }
          userErrors { field message }
        }
      }`;
    await fetch(SHOPIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN
      },
      body: JSON.stringify({ query: mutation })
    });
  } catch (err) {
    console.error('Failed to persist log to Shopify:', err.message);
  }
}

function addLog({ module, status, message, meta = {} }) {
  const entry = { timestamp: new Date().toISOString(), module, status, message, meta };
  logs.unshift(entry);
  if (logs.length > MAX) logs.pop();
  console.log(JSON.stringify(entry));
  persistToShopify(entry); // async, non-blocking
}

function getLogs() { return logs; }

module.exports = { addLog, getLogs };
