const SftpClient = require('ssh2-sftp-client');
const { stringify } = require('csv-stringify/sync');
const { addLog } = require('../logger');

async function handleFulfillmentWebhook(payload) {
  addLog({ module: 'tracking_export', status: 'info', message: `Processing shipment for order ${payload.order_id}` });
  const sftp = new SftpClient();
  try {
    const row = {
      order_name: payload.name || payload.order_id,
      tracking_number: payload.tracking_number || payload.tracking_numbers?.[0],
      carrier: payload.tracking_company,
      tracking_url: payload.tracking_url || payload.tracking_urls?.[0]
    };

    if (!row.tracking_number) {
      addLog({ module: 'tracking_export', status: 'info', message: 'No tracking number yet, skipping' });
      return;
    }

    const csv = stringify([row], { header: true });
    const filename = `tracking_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0,15)}_${String(payload.order_id)}.csv`;

    await sftp.connect({
      host: process.env.TB_SFTP_HOST,
      username: process.env.TB_SFTP_USER,
      password: process.env.TB_SFTP_PASSWORD
    });
    await sftp.put(Buffer.from(csv), `${process.env.TB_SFTP_IN_TRACKING || '/in/tracking/'}${filename}`);
    addLog({ module: 'tracking_export', status: 'success', message: `Uploaded ${filename}`, meta: { order: payload.order_id, tracking: row.tracking_number, carrier: row.carrier } });
  } catch (err) {
    addLog({ module: 'tracking_export', status: 'error', message: err.message, meta: { order: payload.order_id } });
  } finally {
    await sftp.end().catch(() => {});
  }
}


module.exports = { handleFulfillmentWebhook };
