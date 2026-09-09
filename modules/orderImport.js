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
  const json = await res.json();
  if (!res.ok || json.errors) {
    addLog('order_import', 'error', 'Shopify GraphQL/API error', {
      errors: json.errors || { httpStatus: res.status, body: json }
    });
  }
  return json;
}

async function getVariantBySkuOrEan(sku, ean) {
  try {
    addLog('order_import', 'info', `Querying Shopify for SKU: ${sku}`);

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
  } catch (err) {
    addLog('order_import', 'error', `getVariantBySkuOrEan error: ${err.message}`);
    return null;
  }
}

const MARK_PAID_MUTATION = `
  mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order {
        id
        displayFinancialStatus
      }
      userErrors { field message }
    }
  }
`;

// Retry up to 3 times with increasing delays to handle Shopify's
// brief post-creation lock on the order
async function markOrderAsPaid(orderId, orderName) {
  const delays = [2000, 4000, 6000];
  for (const delay of delays) {
    await new Promise(resolve => setTimeout(resolve, delay));
    const paidResult = await shopifyRequest(MARK_PAID_MUTATION, {
      input: { id: orderId }
    });
    const userErrors = paidResult.data?.orderMarkAsPaid?.userErrors || [];
    if (userErrors.length === 0) {
      addLog('order_import', 'info', `Marked as paid: ${orderName}`);
      return true;
    }
    const msg = userErrors.map(e => e.message).join(', ');
    addLog('order_import', 'error', `Mark as paid attempt failed for ${orderName}: ${msg}`);
  }
  addLog('order_import', 'error', `Mark as paid exhausted all retries for ${orderName}`);
  return false;
}

async function createShopifyOrder(order) {
  const orderData = order.ORDER_DATA;
  const shipTo = order.SHIP_TO;
  const sellTo = order.SELL_TO;
  const items = Array.isArray(order.ITEMS.ITEM) ? order.ITEMS.ITEM : [order.ITEMS.ITEM];

  const channelDataArr = Array.isArray(order.ORDER_CHANNEL_DATA?.CHANNEL_DATA)
    ? order.ORDER_CHANNEL_DATA.CHANNEL_DATA
    : [order.ORDER_CHANNEL_DATA?.CHANNEL_DATA];
  const merchantCurrency = channelDataArr.find(d => d?.['@_key'] === 'merchantOrderCurrency')?.['#text'] || 'EUR';

  const lineItems = [];

  for (const item of items) {
    const variant = await getVariantBySkuOrEan(item.SKU, item.EAN);
    if (!variant) {
      addLog('order_import', 'error', `Variant not found for SKU: ${item.SKU} / EAN: ${item.EAN}`);
      continue;
    }

    const itemPrice = typeof item.ITEM_PRICE === 'object'
      ? item.ITEM_PRICE['#text']
      : item.ITEM_PRICE;

    const quantity = parseInt(item.QUANTITY);
    const amount = parseFloat(itemPrice || '0.00');

    lineItems.push({
      variantId: variant.id,
      quantity,
      priceSet: {
        shopMoney: {
          amount: String(amount.toFixed(2)),
          currencyCode: merchantCurrency
        }
      }
    });
  }

  if (lineItems.length === 0) {
    addLog('order_import', 'error', `No valid line items for order ${orderData.CHANNEL_NO} — skipping`);
    return null;
  }

  const shippingPrice = parseFloat(order.SHIPMENT?.PRICE || '0.00');

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
      currency: merchantCurrency,
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
      note: `TB.One Order | Channel: ${orderData.CHANNEL_SIGN} | Channel Order: ${orderData.CHANNEL_NO}`,
      tags: ['tradebyte', 'farfetch', orderData.CHANNEL_SIGN],
      shippingLines: [
        {
          title: 'Farfetch Shipping',
          priceSet: {
            shopMoney: {
              amount: String(shippingPrice.toFixed(2)),
              currencyCode: merchantCurrency
            }
          }
        }
      ],
      metafields: [
        {
          namespace: 'tradebyte',
          key: 'tb_id',
          value: String(orderData.TB_ID || orderData.CHANNEL_NO),
          type: 'single_line_text_field'
        },
        {
          namespace: 'tradebyte',
          key: 'channel_no',
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

  try {
    const result = await shopifyRequest(mutation, variables);

    if (result.data?.orderCreate?.userErrors?.length > 0) {
      addLog('order_import', 'error', 'Shopify userErrors', {
        errors: result.data.orderCreate.userErrors
      });
      return null;
    }

    const shopifyOrder = result.data?.orderCreate?.order;
    if (!shopifyOrder) return null;

    // ✅ Mark as paid with retry — Farfetch only sends pre-paid orders
    await markOrderAsPaid(shopifyOrder.id, shopifyOrder.name);

    return shopifyOrder;
  } catch (err) {
    addLog('order_import', 'error', `Mutation exception: ${err.message}`);
    return null;
  }
}

async function importOrders() {
  addLog('order_import', 'info', 'Starting order import');
  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: process.env.TB_SFTP_HOST,
      username: process.env.TB_SFTP_USER,
      password: process.env.TB_SFTP_PASSWORD
    });

    const files = await sftp.list(SFTP_OUT);
    const orderFiles = files.filter(f => f.name.startsWith('ORDERS_') && f.name.endsWith('.xml'));

    addLog('order_import', 'info', `Files in /out/: ${orderFiles.map(f => f.name).join(', ') || 'EMPTY'}`);

    for (const file of orderFiles) {
      const remotePath = `${SFTP_OUT}${file.name}`;
      const chunks = [];
      await sftp.get(remotePath, require('stream').Writable({
        write(chunk, _, cb) { chunks.push(chunk); cb(); }
      }));
      const xmlContent = Buffer.concat(chunks).toString('utf8');

      addLog('order_import', 'info', `Parsing file: ${file.name}`, {
        preview: xmlContent.substring(0, 300)
      });

      const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });
      const parsed = parser.parse(xmlContent);
      const orderList = parsed.ORDER_LIST;
      const orders = Array.isArray(orderList.ORDER) ? orderList.ORDER : [orderList.ORDER];

      let anyFailed = false;

      for (const order of orders) {
        const channelNo = order.ORDER_DATA?.CHANNEL_NO;
        addLog('order_import', 'info', `Processing order ${channelNo}`);

        const debugItems = Array.isArray(order.ITEMS?.ITEM) ? order.ITEMS.ITEM : [order.ITEMS?.ITEM];
        for (const item of debugItems) {
          addLog('order_import', 'info', `Looking up SKU: "${item?.SKU}" EAN: "${item?.EAN}"`);
        }

        const shopifyOrder = await createShopifyOrder(order);
        if (shopifyOrder) {
          addLog('order_import', 'success', `Order created: ${shopifyOrder.name}`, {
            shopify_order_id: shopifyOrder.id,
            order_name: shopifyOrder.name,
            total_price: shopifyOrder.totalPriceSet?.shopMoney?.amount
          });
        } else {
          anyFailed = true;
        }
      }

      if (!anyFailed) {
        await sftp.rename(remotePath, `${SFTP_ARCHIV}${file.name}`);
        addLog('order_import', 'info', `Archived: ${file.name}`);
      } else {
        await sftp.rename(remotePath, `${SFTP_ARCHIV}FAILED_${file.name}`);
        addLog('order_import', 'error', `Orders failed — moved to FAILED_${file.name}`);
      }
    }
  } catch (err) {
    addLog('order_import', 'error', `Import error: ${err.message}`, { stack: err.stack });
  } finally {
    await sftp.end().catch(() => {});
  }
}

module.exports = { importOrders };
