const SftpClient = require('ssh2-sftp-client');
const { stringify } = require('csv-stringify/sync');
const { addLog } = require('../logger');

async function handleFulfillmentWebhook(payload) {
  addLog({ module: 'tracking_export', status: 'info', message: `Processing fulfillment for order ${payload.order_id}` });
  const sftp = new SftpClient();
  try {
    const row = {
      order_name: payload.name,
      tracking_number: payload.tracking_number,
      carrier: payload.tracking_company,
      tracking_url: payload.tracking_url
    };
    const csv = stringify([row], { header: true });
    const filename = `tracking_${new Date().toISOString().replace(/[-:T]/g, '').slice(0,15)}_${payload.name?.replace('#','')}.csv`;

    await sftp.connect({
      host: process.env.TB_SFTP_HOST,
      username: process.env.TB_SFTP_USER,
      password: process.env.TB_SFTP_PASSWORD
    });
    await sftp.put(Buffer.from(csv), `${process.env.TB_SFTP_IN_TRACKING || '/in/tracking/'}${filename}`);

    addLog({ module: 'tracking_export', status: 'success', message: `Uploaded ${filename}`, meta: { order: payload.name, tracking: payload.tracking_number, carrier: payload.tracking_company } });
  } catch (err) {
    addLog({ module: 'tracking_export', status: 'error', message: err.message, meta: { order: payload.name } });
  } finally {
    await sftp.end();
  }
}

module.exports = { handleFulfillmentWebhook };
