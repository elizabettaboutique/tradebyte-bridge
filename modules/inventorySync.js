const SftpClient = require('ssh2-sftp-client');
const { stringify } = require('csv-stringify/sync');
const { addLog } = require('../logger');

const SHOPIFY_URL = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/graphql.json`;
const LOCATION_ID = 'gid://shopify/Location/12786437';
const BUFFER = parseInt(process.env.INVENTORY_BUFFER || '2');

async function fetchInventory() {
  let items = [], cursor = null, hasNext = true;
  while (hasNext) {
    const query = `{
  location(id: "${LOCATION_ID}") {
    inventoryLevels(first: 250${cursor ? `, after: "${cursor}"` : ''}) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        quantities(names: ["available"]) { name quantity }
        item { sku }
      }}
    }
  }
}`;

    const res = await fetch(SHOPIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN
      },
      body: JSON.stringify({ query })
    });
    const json = await res.json();
    if (!json.data || !json.data.location) {
      throw new Error(`Shopify API error: ${JSON.stringify(json.errors || json)}`);
    }
    const levels = json.data.location.inventoryLevels;
    items.push(...levels.edges.map(e => {
  const availableQty = e.node.quantities?.find(q => q.name === 'available')?.quantity ?? 0;
  return { sku: e.node.item?.sku, available: availableQty };
}));

    hasNext = levels.pageInfo.hasNextPage;
    cursor = levels.pageInfo.endCursor;
  }
  return items;
}

async function syncInventory() {
  addLog({ module: 'inventory_sync', status: 'info', message: 'Starting inventory sync' });
  const sftp = new SftpClient();
  try {
    const items = await fetchInventory();
    const rows = items
      .filter(i => i.item && i.item.sku)
      .map(i => ({
        sku: i.item.sku,
        quantity: Math.max(0, i.available - BUFFER),
        timestamp: new Date().toISOString()
      }));

    const csv = stringify(rows, { header: true });
    const filename = `inventory_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0,15)}.csv`;

    await sftp.connect({
      host: process.env.TB_SFTP_HOST,
      username: process.env.TB_SFTP_USER,
      password: process.env.TB_SFTP_PASSWORD
    });
    await sftp.put(Buffer.from(csv), `${process.env.TB_SFTP_IN_INVENTORY || '/in/inventory/'}${filename}`);
    addLog({ module: 'inventory_sync', status: 'success', message: `Uploaded ${filename}`, meta: { sku_count: rows.length, filename } });
  } catch (err) {
    addLog({ module: 'inventory_sync', status: 'error', message: err.message });
  } finally {
    await sftp.end().catch(() => {});
  }
}

module.exports = { syncInventory };
