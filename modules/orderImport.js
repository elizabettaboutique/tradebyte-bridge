const SftpClient = require('ssh2-sftp-client');
const { XMLParser } = require('fast-xml-parser');
const { addLog } = require('../logger');

const SHOPIFY_URL = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/graphql.json`;

async function createShopifyOrder(order) {
  const mutation = `
    mutation orderCreate($order: OrderCreateOrderInput!) {
      orderCreate(order: $order) {
        order {
          id
          name
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { firstName lastName email }
          lineItems(first: 10) { edges { node { title quantity } } }
        }
        userErrors { field message }
      }
    }`;
  const res = await fetch(SHOPIFY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN
    },
    body: JSON.stringify({ query: mutation, variables: { order } })
  });
  return res.json();
}

function buildShopifyOrder(tbOrder) {
  const data = tbOrder.ORDER_DATA || {};
  const sellTo = tbOrder.SELL_TO || {};
  const shipTo = tbOrder.SHIP_TO || sellTo;
  const items = tbOrder.ITEMS?.ITEM
    ? Array.isArray(tbOrder.ITEMS.ITEM) ? tbOrder.ITEMS.ITEM : [tbOrder.ITEMS.ITEM]
    : [];

  // Farfetch order number from CHANNEL_NO — critical for warehouse
  const farfetchOrderNo = data.CHANNEL_NO || data.CHANNEL_ID || 'unknown';
  const orderNote = `Farfetch-${farfetchOrderNo}`;

  const lineItems = items.map(item => ({
    title: item.BILLING_TEXT || item.SKU || 'Unknown Item',
    quantity: parseInt(item.QUANTITY) || 1,
    priceSet: {
      shopMoney: {
        amount: String(item.ITEM_PRICE || '0.00'),
        currencyCode: 'EUR'
      }
    },
    requiresShipping: true,
    sku: item.SKU || item.EAN || ''
  }));

  return {
    note: orderNote,
    tags: ['tradebyte', 'farfetch'],
    email: sellTo.EMAIL || '',
    phone: sellTo.PHONE_PRIVATE || '',
    financialStatus: 'PAID',
    lineItems,
    billingAddress: {
      firstName: sellTo.FIRSTNAME || sellTo.NAME || '',
      lastName: sellTo.LASTNAME || '',
      address1: sellTo.STREET_NO || '',
      address2: sellTo.STREET_EXTENSION || '',
      zip: sellTo.ZIP || '',
      city: sellTo.CITY || '',
      countryCode: sellTo.COUNTRY || 'DE'
    },
    shippingAddress: {
      firstName: shipTo.FIRSTNAME || shipTo.NAME || '',
      lastName: shipTo.LASTNAME || '',
      address1: shipTo.STREET_NO || '',
      address2: shipTo.STREET_EXTENSION || '',
      zip: shipTo.ZIP || '',
      city: shipTo.CITY || '',
      countryCode: shipTo.COUNTRY || 'DE'
    },
    metafields: [
      {
        namespace: 'tradebyte',
        key: 'tb_id',
        value: String(data.TB_ID || ''),
        type: 'single_line_text_field'
      },
      {
        namespace: 'tradebyte',
        key: 'channel_no',
        value: String(farfetchOrderNo),
        type: 'single_line_text_field'
      }
    ]
  };
}

async function importOrders() {
  addLog({ module: 'order_import', status: 'info', message: 'Starting order import' });
  const sftp = new SftpClient();
  const parser = new XMLParser({ ignoreAttributes: false });

  try {
    await sftp.connect({
      host: process.env.TB_SFTP_HOST,
      username: process.env.TB_SFTP_USER,
      password: process.env.TB_SFTP_PASSWORD
    });

    const dir = process.env.TB_SFTP_OUT_ORDERS || '/out/';
    const files = await sftp.list(dir);
    // Accept TB.One order export formats: TBORDER_xxx.xml, ORDER_xxx.xml, or any .xml
const xmlFiles = files.filter(f =>
  f.name.endsWith('.xml') &&
  !f.name.startsWith('_done') &&
  !f.name.startsWith('_ignore') &&
  !f.name.startsWith('_error') &&
  !f.name.startsWith('_archived') &&
  !f.name.startsWith('_unsupported')
);

    for (const file of xmlFiles) {
      const filePath = `${dir}${file.name}`;
      try {
        const buffer = await sftp.get(filePath);
        const xml = buffer.toString('utf8');
        const parsed = parser.parse(xml);

        // Support both single ORDER and multiple ORDERs
        const orders = parsed.ORDERS?.ORDER
          ? Array.isArray(parsed.ORDERS.ORDER) ? parsed.ORDERS.ORDER : [parsed.ORDERS.ORDER]
          : parsed.ORDER ? [parsed.ORDER] : [];

        for (const tbOrder of orders) {
          const shopifyOrder = buildShopifyOrder(tbOrder);
          const result = await createShopifyOrder(shopifyOrder);
          const created = result.data?.orderCreate?.order;
          const errors = result.data?.orderCreate?.userErrors;

          if (errors?.length > 0) {
            addLog({
              module: 'order_import',
              status: 'error',
              message: `Order creation failed: ${errors.map(e => e.message).join(', ')}`,
              meta: { file: file.name, channel_no: tbOrder.ORDER_DATA?.CHANNEL_NO }
            });
          } else {
            addLog({
              module: 'order_import',
              status: 'success',
              message: `Created order ${created?.name}`,
              meta: {
                shopify_order_id: created?.id,
                order_name: created?.name,
                customer_name: `${created?.customer?.firstName || ''} ${created?.customer?.lastName || ''}`.trim(),
                email: created?.customer?.email || '',
                total_price: created?.totalPriceSet?.shopMoney?.amount || '',
                currency: created?.totalPriceSet?.shopMoney?.currencyCode || 'EUR',
                item_count: created?.lineItems?.edges?.length || 0,
                fulfillment_status: 'unfulfilled',
                imported_at: new Date().toISOString(),
                farfetch_order_no: tbOrder.ORDER_DATA?.CHANNEL_NO || ''
              }
            });
          }
        }

        // Archive processed file to /archiv/ (TB.One spelling)
        const archiveDir = process.env.TB_SFTP_ARCHIVE_ORDERS || '/archiv/';
        await sftp.rename(filePath, `${archiveDir}${file.name}`).catch(async () => {
          await sftp.delete(filePath); // fallback: delete if rename fails
        });

      } catch (fileErr) {
        addLog({
          module: 'order_import',
          status: 'error',
          message: `Failed to process ${file.name}: ${fileErr.message}`
        });
        // Move to error folder
        const errorDir = process.env.TB_SFTP_ERROR_ORDERS || '/out/orders/error/';
        await sftp.rename(filePath, `${errorDir}${file.name}`).catch(() => {});
      }
    }
  } catch (err) {
    addLog({ module: 'order_import', status: 'error', message: err.message });
  } finally {
    await sftp.end().catch(() => {});
  }
}

module.exports = { importOrders };
