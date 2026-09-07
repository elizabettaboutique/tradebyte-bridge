// logger.js - Tradebyte sync logger with Shopify metaobject persistence

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VERSION = '2026-07';
const METAOBJECT_TYPE = 'tradebyte_log';
const MAX_STORED_LOGS = 500;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const logs = [];

function getLogs() {
  return logs;
}

function addLog(module, status, message, metadata = {}) {
  const entry = {
    module,
    status,
    message,
    metadata,
    timestamp: new Date().toISOString(),
  };
  logs.push(entry);
  persistLog(entry).catch(() => {});
  return entry;
}

async function shopifyGraphQL(query, variables) {
  if (!SHOP_DOMAIN || !ADMIN_API_TOKEN) return null;
  const res = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ADMIN_API_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  if (!res.ok) throw new Error('Shopify API HTTP ' + res.status);
  const payload = await res.json();
  if (payload.errors?.length) throw new Error(payload.errors.map(e => e.message).join(', '));
  return payload.data;
}

async function persistLog(entry) {
  await shopifyGraphQL(
    `mutation ($m: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $m) {
        metaobject { id }
        userErrors { field message }
      }
    }`,
    {
      m: {
        type: METAOBJECT_TYPE,
        fields: [
          { key: 'module',    value: String(entry.module  || '') },
          { key: 'status',    value: String(entry.status  || '') },
          { key: 'message',   value: String(entry.message || '') },
          { key: 'timestamp', value: entry.timestamp },
          { key: 'metadata',  value: JSON.stringify(entry.metadata || {}) },
        ],
      },
    }
  );
}

async function pruneOldLogs() {
  const ids = [];
  let cursor = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const data = await shopifyGraphQL(
      `query ($first: Int!, $after: String) {
        metaobjects(type: "${METAOBJECT_TYPE}", first: $first, after: $after, sortKey: "updated_at", reverse: false) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: 250, after: cursor }
    );
    const conn = data?.metaobjects;
    if (!conn) break;
    for (const node of conn.nodes || []) ids.push(node.id);
    hasNextPage = Boolean(conn.pageInfo?.hasNextPage);
    cursor = conn.pageInfo?.endCursor ?? null;
  }
  if (ids.length <= MAX_STORED_LOGS) return 0;
  const stale = ids.slice(0, ids.length - MAX_STORED_LOGS);
  let deleted = 0;
  for (const id of stale) {
    await shopifyGraphQL(
      `mutation ($id: ID!) { metaobjectDelete(id: $id) { deletedId userErrors { message } } }`,
      { id }
    );
    deleted++;
  }
  return deleted;
}

pruneOldLogs().catch(() => {});
const t = setInterval(() => pruneOldLogs().catch(() => {}), PRUNE_INTERVAL_MS);
if (typeof t.unref === 'function') t.unref();

module.exports = { logs, getLogs, addLog, pruneOldLogs };
