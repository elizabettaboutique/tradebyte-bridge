const SftpClient = require('ssh2-sftp-client');
const { XMLParser } = require('fast-xml-parser');
const { addLog } = require('../logger');

const SHOPIFY_URL = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/graphql.json`;
const SFTP_OUT = process.env.TB_SFTP_OUT || '/out/';
const SFTP_ARCHIV = process.env.TB_SFTP_ARCHIV || '/archiv/';

async function shopifyRequest(query, variables) {
  const res = await fetch(SHOPIFY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  return res.json();
}

async function getVariantBySkuOrEan(sku, ean) {
  const result = await shopifyRequest(`{
    productVariants(first: 1, query: "sku:'${sku}'") {
      edges { node { id title price } }
    }
  }`);
  const variant = result.data?.productVariants?.edges?.[0]?.node;
  if (variant) return variant;

  const result2 = await shopifyRequest(`{
    productVariants(first: 1, query: "barcode:'${ean}'") {
      edges { node { id title price } }
    }
  }`);
  return result2.data?.productVariants?.edges?.[0]?.node || null;
}





async function createShopifyOrder(order) {
  const orderData = order.ORDER_DATA;
  const shipTo = order.SHIP_TO;
  const sellTo = order.SELL_TO;
  const items = Array.isArray(order.ITEMS.ITEM) ? order.ITEMS.ITEM : [order.ITEMS.ITEM];

  // Resolve line items
  const lineItems = [];
  for (const item of items) {
    const variant = await getVariantBySkuOrEan(item.SKU, item.EAN);
    if (!variant) {
      addLog({
        module: 'order_import',
        status: 'error',
        message: `Variant not found for SKU: ${item.SKU} / EAN: ${item.EAN}`
      });
      continue;
    }
    lineItems.push({
      variantId: variant.id,
      quantity: parseInt(item.QUANTITY),
      
    });
  }

  if (lineItems.length === 0) {
    addLog({
      module: 'order_import',
      status: 'error',
      message: `No valid line items found for order ${orderData.CHANNEL_NO} — skipping`
    });
    return null;
  }

  const mutation = `
    mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        userErrors { field message }
        order {
          id
          name
          totalPriceSet { shopMoney { amount } }
        }
      }
    }
  `;

  const variables = {
    order: {
      lineItems,
      currency: 'EUR',
      presentmentCurrency: 'EUR',
      shippingAddress: {
        firstName: shipTo.FIRSTNAME,
        lastName: shipTo.LASTNAME,
        address1: shipTo.STREET_NO,
        zip: String(shipTo.ZIP),
        city: shipTo.CITY,
        countryCode: shipTo.COUNTRY
      },
      billingAddress: {
        firstName: sellTo.FIRSTNAME,
        lastName: sellTo.LASTNAME,
        address1: sellTo.STREET_NO,
        zip: String(sellTo.ZIP),
        city: sellTo.CITY,
        countryCode: sellTo.COUNTRY
      },
      email: sellTo.EMAIL,
      phone: null,
      note: `TB.One Order | Channel: ${orderData.CHANNEL_SIGN} | Channel Order: ${orderData.CHANNEL_NO}`,
      tags: ['tradebyte', 'farfetch', orderData.CHANNEL_SIGN],
      shippingLines: [
        {
          title: 'Farfetch Shipping',
          priceSet: {
            shopMoney: {
              amount: String(order.SHIPMENT?.PRICE || '0'),
              currencyCode: 'EUR'
            }
          }
        }
      ],
      metafields: [
        {
          namespace: 'tradebyte',
          key: 'tb_order_id',
          value: String(orderData.TB_ID),
          type: 'single_line_text_field'
        },
        {
          namespace: 'tradebyte',
          key: 'channel_order_no',
          value: String(orderData.CHANNEL_NO),
          type: 'single_line_text_field'
        },
        {
          namespace: 'tradebyte',
          key: 'channel_sign',
          value: String(orderData.CHANNEL_SIGN),
          type: 'single_line_text_field'
        }
      ]
    },
    options: {
      inventoryBehaviour: 'DECREMENT_IGNORING_POLICY'
    }
  };

  const result = await shopifyRequest(mutation, variables);

  if (result.data?.orderCreate?.userErrors?.length > 0) {
    addLog({
      module: 'order_import',
      status: 'error',
      message: `Shopify userErrors: ${JSON.stringify(result.data.orderCreate.userErrors)}`
    });
    return null;
  }

  return result.data?.orderCreate?.order;
}

async function importOrders() {
  addLog({ module: 'order_import', status: 'info', message: 'Starting order import' });
  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: process.env.TB_SFTP_HOST,
      username: process.env.TB_SFTP_USER,
      password: process.env.TB_SFTP_PASSWORD
    });

    const files = await sftp.list(SFTP_OUT);
    const orderFiles = files.filter(f => f.name.startsWith('ORDERS_') && f.name.endsWith('.xml'));

    addLog({
      module: 'order_import',
      status: 'info',
      message: `Files in /out/: ${orderFiles.map(f => f.name).join(', ') || 'EMPTY'}`
    });

    for (const file of orderFiles) {
      const remotePath = `${SFTP_OUT}${file.name}`;
      const chunks = [];
      await sftp.get(remotePath, require('stream').Writable({
        write(chunk, _, cb) { chunks.push(chunk); cb(); }
      }));
      const xmlContent = Buffer.concat(chunks).toString('utf8');

      addLog({
        module: 'order_import',
        status: 'info',
        message: `Parsing file: ${file.name}`,
        meta: { preview: xmlContent.substring(0, 300) }
      });

      const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });
      const parsed = parser.parse(xmlContent);
      const orderList = parsed.ORDER_LIST;
      const orders = Array.isArray(orderList.ORDER) ? orderList.ORDER : [orderList.ORDER];

      for (const order of orders) {
  const channelNo = order.ORDER_DATA?.CHANNEL_NO;
  addLog({ module: 'order_import', status: 'info', message: `Processing order ${channelNo}` });

  const shopifyOrder = await createShopifyOrder(order);
  if (shopifyOrder) {
    addLog({
      module: 'order_import',
      status: 'success',
      message: `Order created: ${shopifyOrder.name}`,
      meta: { id: shopifyOrder.id, total: shopifyOrder.totalPriceSet?.shopMoney?.amount }
    });
  }
}


      // Move to archiv after processing
      await sftp.rename(remotePath, `${SFTP_ARCHIV}${file.name}`);
      addLog({ module: 'order_import', status: 'info', message: `Archived: ${file.name}` });
    }
  } catch (err) {
    addLog({ module: 'order_import', status: 'error', message: `Import error: ${err.message}`, meta: { stack: err.stack } });
  } finally {
    await sftp.end().catch(() => {});
  }
}

module.exports = { importOrders };
