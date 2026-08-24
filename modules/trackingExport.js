const SftpClient = require('ssh2-sftp-client');
const { XMLBuilder } = require('fast-xml-parser');
const { addLog } = require('../logger');

const CARRIER_MAP = {
  'UPS': 'UPS_STD_NATIONAL',
  'FedEx': 'FEDEX_STD_NATIONAL',
  'DHL': 'DHL_STD_WORLD',
  'DPD': 'DPD_STD_NATIONAL',
  'GLS': 'GLS_STD_NATIONAL',
  'Hermes': 'HERMES_STD_NATIONAL',
  'TNT': 'TNT_STD_NATIONAL',
  'Other': 'OTHER'
};

function mapCarrier(shopifyCarrier) {
  if (!shopifyCarrier) return 'OTHER';
  const key = Object.keys(CARRIER_MAP).find(k =>
    shopifyCarrier.toLowerCase().includes(k.toLowerCase())
  );
  return key ? CARRIER_MAP[key] : 'OTHER';
}

function buildShipXml(payload) {
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: true
  });

  // Extract TB_ORDER_ID from order metafields or note
  // The TB_ORDER_ID comes from the original order import
  const tbOrderId = payload.tb_order_id;
  const tbOrderItemId = payload.tb_order_item_id;
  const trackingNumber = payload.tracking_number || payload.tracking_numbers?.[0];
  const carrier = mapCarrier(payload.tracking_company);
  const messageId = `SHIP-${payload.order_id}-${Date.now()}`;

  const message = {
    TB_ORDER_ID: tbOrderId,
    MESSAGE_ID: messageId,
    MESSAGE_TYPE: 'SHIP',
    ITEMS: {
      ITEM: {
        TB_ORDER_ITEM_ID: tbOrderItemId,
        QUANTITY: payload.quantity || 1,
        IDCODE: trackingNumber,
        CARRIER_PARCEL_TYPE: carrier,
        ...(payload.tracking_url ? { TRACKING_URL: payload.tracking_url } : {})
      }
    }
  };

  return builder.build({ MESSAGE: message });
}

async function handleFulfillmentWebhook(payload) {
  addLog({
    module: 'tracking_export',
    status: 'info',
    message: `Processing tracking for order ${payload.order_id}`
  });

  const sftp = new SftpClient();
  try {
    const trackingNumber = payload.tracking_number || payload.tracking_numbers?.[0];

    if (!trackingNumber) {
      addLog({
        module: 'tracking_export',
        status: 'info',
        message: 'No tracking number yet, skipping'
      });
      return;
    }

    // Fetch TB_ORDER_ID and TB_ORDER_ITEM_ID from Shopify order metafields
    const tbIds = await fetchTbOrderIds(payload.order_id);
    if (!tbIds.tbOrderId) {
      addLog({
        module: 'tracking_export',
        status: 'error',
        message: `No TB_ORDER_ID found for Shopify order ${payload.order_id} — was this a Tradebyte order?`
      });
      return;
    }

    const enrichedPayload = {
      ...payload,
      tb_order_id: tbIds.tbOrderId,
      tb_order_item_id: tbIds.tbOrderItemId
    };

    const xml = buildShipXml(enrichedPayload);
    const filename = `ship_${tbIds.tbOrderId}_${Date.now()}.xml`;

    await sftp.connect({
      host: process.env.TB_SFTP_HOST,
      username: process.env.TB_SFTP_USER,
      password: process.env.TB_SFTP_PASSWORD
    });

    const dir = process.env.TB_SFTP_IN_TRACKING || '/in/tracking/';
    await sftp.put(Buffer.from(xml), `${dir}${filename}`);

    addLog({
      module: 'tracking_export',
      status: 'success',
      message: `Uploaded ${filename}`,
      meta: {
        order: payload.order_id,
        tb_order_id: tbIds.tbOrderId,
        tracking: trackingNumber,
        carrier: payload.tracking_company,
        carrier_code: mapCarrier(payload.tracking_company),
        filename
      }
    });
  } catch (err) {
    addLog({
      module: 'tracking_export',
      status: 'error',
      message: err.message,
      meta: { order: payload.order_id }
    });
  } finally {
    await sftp.end().catch(() => {});
  }
}

async function fetchTbOrderIds(shopifyOrderId) {
  const SHOPIFY_URL = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/graphql.json`;
  try
