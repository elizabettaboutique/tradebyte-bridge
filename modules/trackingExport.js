const SftpClient = require('ssh2-sftp-client');
const { XMLBuilder } = require('fast-xml-parser');
const { addLog } = require('../logger');

const CARRIER_MAP = {
  UPS: 'UPS_STD_NATIONAL',
  FedEx: 'FEDEX_STD_NATIONAL',
  DHL: 'DHL_STD_WORLD',
  DPD: 'DPD_STD_NATIONAL',
  GLS: 'GLS_STD_NATIONAL',
  Hermes: 'HERMES_STD_NATIONAL',
  TNT: 'TNT_STD_NATIONAL',
  Other: 'OTHER'
};

function mapCarrier(shopifyCarrier) {
  if (!shopifyCarrier) return 'OTHER';

  const key = Object.keys(CARRIER_MAP).find(name =>
    shopifyCarrier.toLowerCase().includes(name.toLowerCase())
  );

  return key ? CARRIER_MAP[key] : 'OTHER';
}

function getTrackingNumber(payload) {
  return payload.tracking_number || payload.tracking_numbers?.[0] || null;
}

async function fetchTbOrderMapping(shopifyOrderId) {
  const url =
    `https://${process.env.SHOPIFY_SHOP_DOMAIN}` +
    '/admin/api/2025-01/graphql.json';

  const query = `{
    order(id: "gid://shopify/Order/${shopifyOrderId}") {
      metafields(namespace: "tradebyte", first: 20) {
        edges { node { key value } }
      }
    }
  }`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN
    },
    body: JSON.stringify({ query })
  });

  if (!response.ok) {
    throw new Error(`Shopify lookup returned HTTP ${response.status}`);
  }

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(
      `Shopify lookup error: ${json.errors.map(e => e.message).join('; ')}`
    );
  }

  if (!json.data?.order) {
    throw new Error(`Shopify order ${shopifyOrderId} was not returned`);
  }

  const edges = json.data.order.metafields?.edges || [];
  const valueFor = key =>
    edges.find(edge => edge.node?.key === key)?.node?.value || null;

  const tbOrderId = valueFor('tb_id');
  const rawItems = valueFor('tb_items');

  // An order without tb_id is not identified as a TB.One order.
  if (!tbOrderId) return null;

  if (!Number.isSafeInteger(Number(tbOrderId)) ||
      Number(tbOrderId) <= 0) {
    throw new Error(`Invalid TB.One order ID: ${tbOrderId}`);
  }

  if (!rawItems) {
    throw new Error(
      `TB.One order ${tbOrderId} has no tradebyte.tb_items mapping; ` +
      'do not substitute channel_no or guess an item ID'
    );
  }

  let tbItems;
  try {
    tbItems = JSON.parse(rawItems);
  } catch {
    throw new Error(`Invalid tradebyte.tb_items JSON for order ${tbOrderId}`);
  }

  if (!Array.isArray(tbItems) || tbItems.length === 0) {
    throw new Error(`Empty TB.One item mapping for order ${tbOrderId}`);
  }

  const seenSkus = new Set();

  for (const item of tbItems) {
    if (!item?.sku ||
        !Number.isSafeInteger(Number(item.tbItemId)) ||
        Number(item.tbItemId) <= 0 ||
        seenSkus.has(item.sku)) {
      throw new Error(
        `Invalid or ambiguous TB.One item mapping for order ${tbOrderId}`
      );
    }
    seenSkus.add(item.sku);
  }

  return { tbOrderId: Number(tbOrderId), tbItems };
}

function buildShipXml(messages) {
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true
  });

  const body = builder.build({
    MESSAGES_LIST: {
      MESSAGE: messages.length === 1 ? messages[0] : messages
    }
  });

  return `<?xml version="1.0" encoding="utf-8"?>\n${body}`;
}

function buildMessages(payload, mapping) {
  const fulfilledItems = payload.line_items;

  if (!Array.isArray(fulfilledItems) || fulfilledItems.length === 0) {
    throw new Error('Fulfillment contains no line_items');
  }

  const trackingNumber = getTrackingNumber(payload);
  if (!trackingNumber) {
    throw new Error('Fulfillment has no tracking number');
  }

  const messages = fulfilledItems.map(lineItem => {
    const sku = String(lineItem.sku || '').trim();
    const quantity = Number(lineItem.quantity);
    const matches = mapping.tbItems.filter(item => item.sku === sku);

    if (matches.length !== 1) {
      throw new Error(
        `Cannot uniquely match fulfilled SKU "${sku}" to a TB.One item`
      );
    }

    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error(`Invalid fulfilled quantity for SKU "${sku}"`);
    }

    // Field layout follows TB.One's supplied SHIP example: fields are direct
    // children of MESSAGE, not nested under ITEMS / ITEM.
    return {
      MESSAGE_TYPE: 'SHIP',
      TB_ORDER_ID: mapping.tbOrderId,
      TB_ORDER_ITEM_ID: Number(matches[0].tbItemId),
      SKU: sku,
      QUANTITY: quantity,
      CARRIER_PARCEL_TYPE: mapCarrier(payload.tracking_company),
      IDCODE: trackingNumber
    };
  });

  return messages;
}

// Selina specified filenames such as MESSAGES_202609301551.xml.
// UTC makes the timestamp independent of the Railway server's local timezone.
function messageFilename(date = new Date()) {
  const timestamp = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0')
  ].join('');

  return `MESSAGES_${timestamp}.xml`;
}

async function handleFulfillmentWebhook(payload) {
  const shopifyOrderId = payload?.order_id;

  if (!shopifyOrderId) {
    addLog('tracking_export', 'error',
      'Fulfillment webhook has no Shopify order ID'
    );
    return;
  }

  let mapping;
  let messages;

  try {
    mapping = await fetchTbOrderMapping(shopifyOrderId);

    if (!mapping) return; // Not identified as a TB.One order.

    if (!getTrackingNumber(payload)) {
      addLog('tracking_export', 'info',
        `No tracking number for Shopify order ${shopifyOrderId}; skipping`,
        { order: shopifyOrderId, tb_order_id: mapping.tbOrderId }
      );
      return;
    }

    messages = buildMessages(payload, mapping);
  } catch (error) {
    addLog('tracking_export', 'error',
      `Shipment not uploaded for Shopify order ${shopifyOrderId}: ${error.message}`,
      { order: shopifyOrderId }
    );
    return;
  }

  const filename = messageFilename();
  const directory = (
    process.env.TB_SFTP_IN_TRACKING || '/in/'
  ).replace(/\/?$/, '/');
  const remotePath = `${directory}${filename}`;
  const xml = buildShipXml(messages);
  const sftp = new SftpClient();

  try {
    await sftp.connect({
      host: process.env.TB_SFTP_HOST,
      username: process.env.TB_SFTP_USER,
      password: process.env.TB_SFTP_PASSWORD
    });

    // The required filename has only minute precision. Do not overwrite
    // another shipment uploaded during the same minute.
    if (await sftp.exists(remotePath)) {
      throw new Error(
        `${filename} already exists in ${directory}; ` +
        'shipment not uploaded. Retry in a later minute.'
      );
    }

    await sftp.put(Buffer.from(xml, 'utf8'), remotePath);

    addLog('tracking_export', 'info',
      `Uploaded ${filename} to SFTP; TB.One processing not yet confirmed`,
      {
        order: shopifyOrderId,
        tb_order_id: mapping.tbOrderId,
        fulfilled_item_count: messages.length,
        tracking: getTrackingNumber(payload),
        filename,
        remote_path: remotePath
      }
    );
  } catch (error) {
    addLog('tracking_export', 'error',
      `Shipment upload failed for Shopify order ${shopifyOrderId}: ${error.message}`,
      {
        order: shopifyOrderId,
        tb_order_id: mapping.tbOrderId,
        filename
      }
    );
  } finally {
    await sftp.end().catch(() => {});
  }
}

module.exports = { handleFulfillmentWebhook };
