const SftpClient = require('ssh2-sftp-client');
const { parse } = require('csv-parse/sync');
const { addLog } = require('../logger');

const SHOPIFY_URL = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/graphql.json`;

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


async function importOrders() {
  addLog({ module: 'order_import', status: 'info', message: 'Checking for new orders' });
  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: process.env.TB_SFTP_HOST,
      username: process.env.TB_SFTP_USER,
      password: process.env.TB_SFTP_PASSWORD
    });

    const outFolder = process.env.TB_SFTP_OUT_ORDERS || '/out/orders/';
    const files = await sftp.list(outFolder);
    const csvFiles = files.filter(f => f.name.endsWith('.csv'));

    addLog({ module: 'order_import', status: 'info', message: `Found ${csvFiles.length} order file(s)` });

    for (const file of csvFiles) {
      const filePath = `${outFolder}${file.name}`;
      try {
        const buffer = await sftp.get(filePath);
        const rows = parse(buffer, { columns: true, skip_empty_lines: true });

        for (const row of rows) {
          const orderInput = {
            email: row.email,
            phone: row.phone,
            shippingAddress: {
              firstName: row.first_name,
              lastName: row.last_name,
              address1: row.address1,
              address2: row.address2 || '',
              city: row.city,
              province: row.province,
              zip: row.zip,
              countryCode: row.country_code
            },
            lineItems: [{
              variantId: row.variant_id,
              quantity: parseInt(row.quantity),
              priceSet: { shopMoney: { amount: row.price, currencyCode: 'USD' } }
            }]
          };
          const result = await createShopifyOrder(orderInput);
          const created = result.data?.orderCreate?.order;
                  addLog({
                    module: 'order_import',
                    status: 'success',
                    message: `Created order ${created?.name}`,
                    meta: {
                      shopify_order_id: created?.id,
                      order_name: created?.name,
                      customer_name: `${created?.customer?.firstName || row.first_name} ${created?.customer?.lastName || row.last_name}`,
                      email: created?.customer?.email || row.email,
                      total_price: created?.totalPriceSet?.shopMoney?.amount || row.price,
                      currency: created?.totalPriceSet?.shopMoney?.currencyCode || 'USD',
                      item_count: created?.lineItems?.edges?.length || 1,
                      fulfillment_status: 'unfulfilled',
                      imported_at: new Date().toISOString()
                    }
                  });

        }

        // Archive the file
        await sftp.rename(filePath, `${process.env.TB_SFTP_ARCHIVE || '/archive/'}${file.name}`);
      } catch (err) {
        addLog({ module: 'order_import', status: 'error', message: `Failed processing ${file.name}: ${err.message}` });
        await sftp.rename(filePath, `${process.env.TB_SFTP_ERROR || '/error/'}${file.name}`).catch(() => {});
      }
    }
  } catch (err) {
    addLog({ module: 'order_import', status: 'error', message: err.message });
  } finally {
    await sftp.end();
  }
}

module.exports = { importOrders };
