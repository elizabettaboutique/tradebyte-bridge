const SftpClient = require('ssh2-sftp-client');
const { XMLParser } = require('fast-xml-parser');
const { addLog } = require('../logger');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

if (!/^\d{4}-(01|04|07|10)$/.test(API_VERSION)) {
  throw new Error(
    'SHOPIFY_API_VERSION must be a version string such as 2026-07'
  );
}

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;

if (!SHOP_DOMAIN) {
  throw new Error('SHOPIFY_SHOP_DOMAIN is required');
}

const SHOPIFY_URL =
  `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

const SHOPIFY_REST_BASE =
  `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}`;

const TEXAS_LOCATION_ID = 12786437;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function manualReviewError(message) {
  const error = new Error(message);
  error.manualReview = true;
  return error;
}




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


async function shopifyRestRequest(resourcePath, options = {}) {
  const method = (options.method || 'GET').toUpperCase();

  const response = await fetch(
    `${SHOPIFY_REST_BASE}${resourcePath}`,
    {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token':
          process.env.SHOPIFY_ADMIN_API_TOKEN,
        ...options.headers
      },
      signal: AbortSignal.timeout(30000)
    }
  );

  const text = await response.text();

  if (!response.ok) {
    const error = new Error(
      `Shopify REST ${method} ${resourcePath} failed ` +
      `(${response.status}): ${text.slice(0, 1000)}`
    );

    error.httpStatus = response.status;
    error.manualReview = response.status === 422;
    throw error;
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Invalid JSON from Shopify REST ${method} ${resourcePath}`
    );
  }
}



// ---------------------------------------------------------------------------
// Wait for Shopify to produce fulfillment orders.
// Bounded retries: six attempts with 31 seconds of backoff in total.
// Request durations can add to that time.
// ---------------------------------------------------------------------------
async function getRoutedFulfillmentOrders(orderId, orderName) {
  const delays = [0, 1000, 2000, 4000, 8000, 16000];
  const retryableStatuses = [429, 500, 502, 503, 504];

  let lastError;

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) {
      await wait(delays[attempt]);
    }

    try {
      const result = await shopifyRestRequest(
        `/orders/${orderId}/fulfillment_orders.json`
      );

      if (!Array.isArray(result.fulfillment_orders)) {
        throw new Error(
          `Invalid fulfillment-order response for ${orderName}`
        );
      }

      if (result.fulfillment_orders.length > 0) {
        return result.fulfillment_orders;
      }

      lastError = new Error(
        `No fulfillment orders returned yet for ${orderName}`
      );

      addLog(
        'order_import',
        'info',
        `Waiting for routing for ${orderName}; ` +
        `attempt ${attempt + 1}/${delays.length}`,
        { shopify_order_id: orderId }
      );
    } catch (error) {
      lastError = error;

      // Do not repeatedly retry invalid URLs, access failures, or 422s.
      if (!retryableStatuses.includes(error.httpStatus)) {
        throw error;
      }
    }
  }

  throw lastError || new Error(
    `Routing lookup exhausted retries for ${orderName}`
  );
}

function getActiveFulfillmentOrders(fulfillmentOrders) {
  return fulfillmentOrders.filter(fulfillmentOrder =>
    !['closed', 'cancelled'].includes(
      String(fulfillmentOrder.status).toLowerCase()
    )
  );
}



// ---------------------------------------------------------------------------
// Assign this Tradebyte order's active fulfillment orders to Texas.
// Call only for orders identified as Tradebyte imports.
// ---------------------------------------------------------------------------
async function moveTradebyteOrderToTexas(orderGid, orderName) {
  const orderId = String(orderGid).split('/').pop();

  if (!/^\d+$/.test(orderId)) {
    throw manualReviewError(
      `Invalid Shopify order ID for ${orderName}`
    );
  }

  const fulfillmentOrders = await getRoutedFulfillmentOrders(
    orderId,
    orderName
  );

  const activeOrders = getActiveFulfillmentOrders(
    fulfillmentOrders
  );

  if (activeOrders.length === 0) {
    throw manualReviewError(
      `No active fulfillment orders for ${orderName}; ` +
      'check its fulfillment history'
    );
  }

  // Check every required move before moving any fulfillment order.
  for (const fulfillmentOrder of activeOrders) {
    if (
      Number(fulfillmentOrder.assigned_location_id) ===
      TEXAS_LOCATION_ID
    ) {
      continue;
    }

    const status = String(
      fulfillmentOrder.status || ''
    ).toLowerCase();

    const requestStatus = String(
      fulfillmentOrder.request_status || ''
    ).toLowerCase();

    // Conservative policy: unsupported or unknown request states
    // require review instead of an automatic move.
    if (
      status !== 'open' ||
      !['unsubmitted', 'rejected'].includes(requestStatus)
    ) {
      throw manualReviewError(
        `Cannot automatically move fulfillment order ` +
        `${fulfillmentOrder.id} for ${orderName}: ` +
        `status=${status}, request_status=${requestStatus}`
      );
    }
  }

  for (const fulfillmentOrder of activeOrders) {
    if (
      Number(fulfillmentOrder.assigned_location_id) ===
      TEXAS_LOCATION_ID
    ) {
      continue;
    }

    await shopifyRestRequest(
      `/fulfillment_orders/${fulfillmentOrder.id}/move.json`,
      {
        method: 'POST',
        body: JSON.stringify({
          fulfillment_order: {
            new_location_id: TEXAS_LOCATION_ID
          }
        })
      }
    );
  }

  // Re-read the order because moves can change fulfillment-order records.
  const updatedOrders = await getRoutedFulfillmentOrders(
    orderId,
    orderName
  );

  const updatedActiveOrders = getActiveFulfillmentOrders(
    updatedOrders
  );

  const texasConfirmed =
    updatedActiveOrders.length > 0 &&
    updatedActiveOrders.every(fulfillmentOrder =>
      Number(fulfillmentOrder.assigned_location_id) ===
      TEXAS_LOCATION_ID
    );

  if (!texasConfirmed) {
    throw new Error(
      `Texas assignment was not confirmed for ${orderName}`
    );
  }

  addLog(
    'order_import',
    'success',
    `Confirmed ${orderName} fulfillment at Texas`,
    { shopify_order_id: orderGid }
  );

  return true;
}


// ---------------------------------------------------------------------------
// Read a value from a CHANNEL_DATA array by key
// ---------------------------------------------------------------------------
function getChannelDataValue(channelData, key) {
  if (!channelData) return null;
  const arr = Array.isArray(channelData) ? channelData : [channelData];
  const entry = arr.find(d => d?.['@_key'] === key);
  return entry?.['#text'] ? String(entry['#text']) : null;
}

// ---------------------------------------------------------------------------
// Read merchantOrderProductBasePrice from ORDER_ITEM_CHANNEL_DATA.
// Falls back to ITEM_PRICE if not found.
// ---------------------------------------------------------------------------
function getItemPrice(item) {
  const channelData = item?.ORDER_ITEM_CHANNEL_DATA?.CHANNEL_DATA;
  if (channelData) {
    const basePrice = getChannelDataValue(channelData, 'merchantOrderProductBasePrice');
    if (basePrice) {
      return parseFloat(basePrice);
    }
  }
  // Fallback to ITEM_PRICE
  const rawPrice = typeof item.ITEM_PRICE === 'object'
    ? item.ITEM_PRICE['#text']
    : item.ITEM_PRICE;
  return parseFloat(rawPrice || '0.00');
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

  // ---------------------------------------------------------------------------
  // Currency: use merchantOrderCurrency (USD) from ORDER_CHANNEL_DATA.
  // The prices in ORDER_ITEM_CHANNEL_DATA are always in merchantOrderCurrency.
  // Fall back to 'currency' field, then SERVICES CURRENCY, then 'USD'.
  // ---------------------------------------------------------------------------
  const orderChannelData = order.ORDER_CHANNEL_DATA?.CHANNEL_DATA;
  const tbCurrency =
    getChannelDataValue(orderChannelData, 'merchantOrderCurrency') ||
    getChannelDataValue(orderChannelData, 'currency') ||
    'USD';

  if (!getChannelDataValue(orderChannelData, 'merchantOrderCurrency')) {
    addLog('order_import', 'error',
      `No merchantOrderCurrency found for order ${orderData.CHANNEL_NO} — falling back to: ${tbCurrency}`
    );
  }

  addLog('order_import', 'info', `Order currency: ${tbCurrency}`);

  const lineItems = [];
  const tbItems = [];
  const seenSkus = new Set();

  for (const item of items) {
    const variant = await getVariantBySkuOrEan(item.SKU, item.EAN);
    if (!variant) {
      addLog('order_import', 'error', `Variant not found for SKU: ${item.SKU} / EAN: ${item.EAN}`);
      continue;
    }

    const quantity = parseInt(item.QUANTITY);
    // ✅ Use merchantOrderProductBasePrice (retail USD price), fall back to ITEM_PRICE
    const amount = getItemPrice(item);

    addLog('order_import', 'info',
      `Item price: ${amount} ${tbCurrency} (SKU: ${item.SKU})`
    );

        const tbItemId = Number(item.TB_ID);
    const sku = String(item.SKU || '').trim();

    if (!Number.isSafeInteger(tbItemId) || tbItemId <= 0 || !sku) {
      addLog('order_import', 'error',
        `Missing valid TB.One item ID or SKU for order ${orderData.CHANNEL_NO}; skipping entire order`
      );
      return null;
    }

    // This mapping uses SKU to match a later Shopify fulfillment to its
    // TB.One item. Never guess when two TB.One items share the same SKU.
    if (seenSkus.has(sku)) {
      addLog('order_import', 'error',
        `Duplicate SKU ${sku} in TB.One order ${orderData.CHANNEL_NO}; skipping entire order because shipment items would be ambiguous`
      );
      return null;
    }

    seenSkus.add(sku);
    tbItems.push({ sku, tbItemId });

    
    lineItems.push({
      variantId: variant.id,
      quantity,
      requiresShipping: true,
      priceSet: {
        shopMoney: {
          amount: String(amount.toFixed(2)),
          currencyCode: tbCurrency
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
          totalPriceSet { shopMoney { amount currencyCode } }
        }
      }
    }
  `;

  if (!Number.isSafeInteger(Number(orderData.TB_ID)) ||
      Number(orderData.TB_ID) <= 0) {
    addLog('order_import', 'error',
      `Missing valid TB.One order ID for ${orderData.CHANNEL_NO}; skipping`
    );
    return null;
  }



  
  const variables = {
    order: {
      lineItems,
      currency: tbCurrency,
      // ✅ Full address mapping including STATE and STREET_EXTENSION
      shippingAddress: {
        firstName: shipTo.FIRSTNAME,
        lastName: shipTo.LASTNAME,
        address1: shipTo.STREET_NO,
        address2: shipTo.STREET_EXTENSION || '',
        zip: String(shipTo.ZIP),
        city: shipTo.CITY,
        province: shipTo.STATE || '',
        countryCode: shipTo.COUNTRY
      },
      billingAddress: {
        firstName: sellTo.FIRSTNAME,
        lastName: sellTo.LASTNAME,
        address1: sellTo.STREET_NO,
        address2: sellTo.STREET_EXTENSION || '',
        zip: String(sellTo.ZIP),
        city: sellTo.CITY,
        province: sellTo.STATE || '',
        countryCode: sellTo.COUNTRY
      },
      email: sellTo.EMAIL,
      note: `TB.One Order | Channel: ${orderData.CHANNEL_SIGN} | Channel Order: ${orderData.CHANNEL_NO} | Currency: ${tbCurrency}`,
      tags: ['tradebyte', 'farfetch', orderData.CHANNEL_SIGN],
      // ✅ Always include a shipping line to prevent "shipping not required"
      shippingLines: [
        {
          title: 'Farfetch Shipping',
          priceSet: {
            shopMoney: {
              amount: String(shippingPrice.toFixed(2)),
              currencyCode: tbCurrency
            }
          }
        }
      ],
      metafields: [
        {
          namespace: 'tradebyte',
          key: 'tb_id',
          value: String(orderData.TB_ID),
          type: 'single_line_text_field'
        },
         {
          namespace: 'tradebyte',
          key: 'tb_items',
          value: JSON.stringify(tbItems),
          type: 'json'
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
        },
        {
          namespace: 'tradebyte',
          key: 'currency',
          value: tbCurrency,
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


    let texasMoveSucceeded = false;

try {
  await moveTradebyteOrderToTexas(shopifyOrder.id, shopifyOrder.name);
  texasMoveSucceeded = true;
} catch (err) {
  addLog(
    'order_import',
    'error',
    `CRITICAL: ${shopifyOrder.name} was created, but Texas assignment failed: ${err.message}`
  );
}

// Still mark the prepaid order paid, even if the location move needs attention.
await markOrderAsPaid(shopifyOrder.id, shopifyOrder.name);

if (!texasMoveSucceeded) {
  return null;
}


    // Mark as paid — Farfetch only sends pre-paid orders
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
            total_price: shopifyOrder.totalPriceSet?.shopMoney?.amount,
            currency: shopifyOrder.totalPriceSet?.shopMoney?.currencyCode
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
