const SftpClient = require('ssh2-sftp-client');
const { XMLBuilder } = require('fast-xml-parser');
const { addLog } = require('../logger');

const SHOPIFY_URL = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/graphql.json`;
const LOCATION_ID = 'gid://shopify/Location/12786437';
const BUFFER = parseInt(process.env.INVENTORY_BUFFER || '2');

function getTbFilename(prefix) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const uid = Math.floor(Date.now() / 1000);
  return `${date}_${time}_${prefix}_${uid}.xml`;
}

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
    if (!json.data?.location) {
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

function buildXml(items) {
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: true
  });

  const articles = items
    .filter(i => i.sku)
    .map(i => ({
      A_NR: i.sku,
      A_STOCK: Math.max(0, i.available - BUFFER)
    }));

  return builder.build({
    TBSTOCK: {
      '@_changedate': Math.floor(Date.now() / 1000),
      ARTICLE: articles
    }
  });
}

async function syncInventory() {
  addLog({ module: 'inventory_sync', status: 'info', message: 'Starting inventory sync' });
  const sftp = new SftpClient();
  try {
    const items = await fetchInventory();
    const xml = buildXml(items);
    const skuCount = items.filter(i => i.sku).length;
    const filename = getTbFilename('TBSTOCK');

    await sftp.connect({
      host: process.env.TB_SFTP_HOST,
      username: process.env.TB_SFTP_USER,
      password: process.env.TB_SFTP_PASSWORD
    });

    const dir = process.env.TB_SFTP_IN_INVENTORY || '/in/';
    await sftp.put(Buffer.from(xml), `${dir}${filename}`);

    addLog({
      module: 'inventory_sync',
      status: 'success',
      message: `Uploaded ${filename}`,
      meta: { sku_count: skuCount, filename }
    });
  } catch (err) {
    addLog({ module: 'inventory_sync', status: 'error', message: err.message });
  } finally {
    await sftp.end().catch(() => {});
  }
}

module.exports = { syncInventory };
