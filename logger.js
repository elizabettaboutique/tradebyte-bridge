// logger.js - Tradebyte sync logger with Shopify metaobject persistence

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VERSION = '2026-07';
const METAOBJECT_TYPE = 'tradebyte_log';
const MAX_STORED_LOGS = 500;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// In-memory log store (unchanged behaviour)
// ---------------------------------------------------------------------------
const logs = [];

function getLogs() {
  return logs;
}

function addLog(module, status, message, metadata = {}) {
  const entry = {
    module: module,
    status: status,
    message: message,
    metadata: metadata,
    timestamp: new Date().toISOString(),
  };

  logs.push(entry);

console.log(`[${entry.timestamp}] module: ${module} status: ${status} message: ${message} meta: ${JSON.stringify(metadata)}`);

  
  // Fire and forget: persistence must never block or crash the caller.
  persistLog(entry).catch(function () {});

  return entry;
}

// ---------------------------------------------------------------------------
// Shopify Admin API helper
// ---------------------------------------------------------------------------
const CREATE_LOG_MUTATION = `mutation CreateTradebyteLog($metaobject: MetaobjectCreateInput!) {
  metaobjectCreate(metaobject: $metaobject) {
    metaobject {
      id
    }
    userErrors {
      field
      message
    }
  }
}`;

const LIST_LOGS_QUERY = `query ListTradebyteLogs($type: String!, $first: Int!, $after: String) {
  metaobjects(type: $type, first: $first, after: $after, sortKey: "updated_at", reverse: false) {
    nodes {
      id
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const DELETE_LOG_MUTATION = `mutation DeleteTradebyteLog($id: ID!) {
  metaobjectDelete(id: $id) {
    deletedId
    userErrors {
      field
      message
    }
  }
}`;

async function shopifyGraphQL(query, variables) {
  if (!SHOP_DOMAIN || !ADMIN_API_TOKEN) {
    throw new Error('SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_API_TOKEN must be set');
  }

  const endpoint = 'https://' + SHOP_DOMAIN + '/admin/api/' + API_VERSION + '/graphql.json';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ADMIN_API_TOKEN,
    },
    body: JSON.stringify({ query: query, variables: variables }),
  });

  if (!response.ok) {
    throw new Error('Shopify Admin API returned HTTP ' + response.status);
  }

  const payload = await response.json();

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(
      payload.errors
        .map(function (item) {
          return item.message;
        })
        .join(', '),
    );
  }

  return payload.data;
}

function userErrorText(userErrors) {
  return userErrors
    .map(function (item) {
      const field = item.field && item.field.length > 0 ? item.field.join('.') + ': ' : '';
      return field + item.message;
    })
    .join(', ');
}

// ---------------------------------------------------------------------------
// Persist a single log entry to a tradebyte_log metaobject
// ---------------------------------------------------------------------------
async function persistLog(entry) {
  const data = await shopifyGraphQL(CREATE_LOG_MUTATION, {
    metaobject: {
      type: METAOBJECT_TYPE,
      fields: [
        { key: 'module', value: String(entry.module || '') },
        { key: 'status', value: String(entry.status || '') },
        { key: 'message', value: String(entry.message || '') },
        { key: 'timestamp', value: entry.timestamp || new Date().toISOString() },
        { key: 'metadata', value: JSON.stringify(entry.metadata || {}) },
      ],
    },
  });

  const userErrors = data && data.metaobjectCreate ? data.metaobjectCreate.userErrors || [] : [];

  if (userErrors.length > 0) {
    throw new Error(userErrorText(userErrors));
  }

  return data.metaobjectCreate.metaobject.id;
}

// ---------------------------------------------------------------------------
// Keep only the newest MAX_STORED_LOGS metaobjects of type tradebyte_log
// ---------------------------------------------------------------------------
async function pruneOldLogs() {
  const ids = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphQL(LIST_LOGS_QUERY, {
      type: METAOBJECT_TYPE,
      first: 250,
      after: cursor,
    });

    const connection = data ? data.metaobjects : null;
    if (!connection) break;

    const nodes = connection.nodes || [];
    for (let i = 0; i < nodes.length; i += 1) {
      if (nodes[i] && nodes[i].id) ids.push(nodes[i].id);
    }

    hasNextPage = Boolean(connection.pageInfo && connection.pageInfo.hasNextPage);
    cursor = connection.pageInfo ? connection.pageInfo.endCursor : null;
  }

  if (ids.length <= MAX_STORED_LOGS) return 0;

  // ids are ordered oldest first, so the head of the list is what we drop.
  const staleIds = ids.slice(0, ids.length - MAX_STORED_LOGS);
  let deleted = 0;

  for (let i = 0; i < staleIds.length; i += 1) {
    const data = await shopifyGraphQL(DELETE_LOG_MUTATION, { id: staleIds[i] });
    const userErrors = data && data.metaobjectDelete ? data.metaobjectDelete.userErrors || [] : [];
    if (userErrors.length === 0) deleted += 1;
  }

  return deleted;
}

// Run cleanup once on startup, then once a day. Failures are swallowed so a
// logging problem can never take the sync process down.
pruneOldLogs().catch(function () {});

const pruneTimer = setInterval(function () {
  pruneOldLogs().catch(function () {});
}, PRUNE_INTERVAL_MS);

if (typeof pruneTimer.unref === 'function') {
  pruneTimer.unref();
}

module.exports = {
  logs: logs,
  getLogs: getLogs,
  addLog: addLog,
  pruneOldLogs: pruneOldLogs,
};
