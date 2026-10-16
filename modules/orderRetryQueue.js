'use strict';
// Add as modules/orderRetryQueue.js. Requires a persistent Railway volume.
// Contains no Shopify operations: invokes existing bridge functions passed in.
const fs = require('fs');
const path = require('path');

const root = process.env.BRIDGE_STATE_DIR;
if (!root || !path.isAbsolute(root)) {
  throw new Error('BRIDGE_STATE_DIR must point to an absolute path on a mounted persistent volume');
}
const directory = path.join(root, 'order-retries');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const MAX_ATTEMPTS = 3;
const DELAY_MS = 30 * 60 * 1000;

function keyOf(order) {
  const key = String(order?.ORDER_DATA?.TB_ID || '').trim();
  if (!/^\d+$/.test(key) || Number(key) <= 0) throw new Error('Missing valid TB.One order ID');
  return key;
}
function fileFor(key) {
  if (!/^\d+$/.test(String(key))) throw new Error('Invalid retry record key');
  return path.join(directory, `tb-${key}.json`);
}
function read(key) {
  try { return JSON.parse(fs.readFileSync(fileFor(key), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function save(record) {
  record.updatedAt = new Date().toISOString();
  const target = fileFor(record.tbId);
  const temporary = `${target}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
  const directoryFd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}
function creationRejected(message) {
  const error = new Error(message);
  error.creationRejected = true;
  return error;
}
function markCreateDispatched(key) {
  const record = read(key);
  if (!record || record.state !== 'running' || record.shopifyOrder || record.dispatched) {
    throw new Error('Unsafe creation attempt: missing or already-dispatched retry reservation');
  }
  record.dispatched = true;
  record.step = 'create';
  save(record); // Before sending the request, not afterward.
}
function rememberCreated(key, shopifyOrder) {
  if (!shopifyOrder?.id) throw new Error('Cannot save a Shopify order without an ID');
  const record = read(key);
  if (!record) throw new Error('Missing retry reservation');
  if (record.shopifyOrder && record.shopifyOrder.id !== shopifyOrder.id) {
    throw new Error('Shopify order ID conflict: manual reconciliation required');
  }
  record.shopifyOrder = shopifyOrder;
  record.dispatched = false;
  record.step = 'assign_texas';
  save(record);
}
function emit(log, record, status, message) {
  log('order_import', status, message, {
    tb_order_id: record.tbId,
    shopify_order_id: record.shopifyOrder?.id || null,
    step: record.step,
    attempts: record.attempts,
    state: record.state,
    error: record.lastError || null
  });
}
async function processOrder(order, handlers) {
  const key = keyOf(order);
  const channelNo = String(order.ORDER_DATA.CHANNEL_NO || '');
  let record = read(key);
  if (record && record.channelNo !== channelNo) throw new Error('TB.One ID/channel-order conflict');
  if (!record) {
    record = {
      tbId: key, channelNo, order, attempts: 0, state: 'pending',
      step: 'create', dispatched: false, shopifyOrder: null,
      texasConfirmed: false, paidConfirmed: false,
      nextAttemptAt: 0, createdAt: new Date().toISOString()
    };
    save(record);
  }
  if (record.state === 'complete') return record.shopifyOrder;
  if (record.state === 'manual_review') return null;

  // A process died during a previous attempt. A dispatched creation with no
  // checkpoint is uncertain; never issue creation again automatically.
  if (record.state === 'running') {
    if (!record.shopifyOrder && record.dispatched) {
      record.state = 'manual_review';
      record.lastError = 'Creation outcome unknown after interrupted run; reconcile Shopify before retry';
      save(record);
      emit(handlers.log, record, 'error', `Manual review required for TB.One ${key}`);
      return null;
    }
    record.state = 'pending';
    record.nextAttemptAt = 0;
    save(record);
  }
  if (record.nextAttemptAt > Date.now()) return null;
  if (record.attempts >= MAX_ATTEMPTS) {
    record.state = 'manual_review';
    record.lastError = record.lastError || 'Automatic attempt limit reached';
    save(record);
    emit(handlers.log, record, 'error', `Retry limit reached for TB.One ${key}`);
    return null;
  }
  record.attempts += 1;
  record.state = 'running';
  save(record);
  try {
    if (!record.shopifyOrder) {
      const created = await handlers.create(record.order);
      if (!created?.id) throw new Error('Order creation returned no order; inspect validation logs');
      // create() must call rememberCreated immediately on a returned order ID.
      record = read(key);
      if (record.shopifyOrder?.id !== created.id) {
        throw new Error('Creation checkpoint missing; manual reconciliation required');
      }
    }
    // Confirm prepaid status independently of the location move. A failed
    // assignment must not leave a real prepaid order incorrectly unpaid.
    if (!record.paidConfirmed) {
      record.step = 'confirm_payment';
      save(record);
      const paid = await handlers.confirmPaid(record.shopifyOrder.id, record.shopifyOrder.name);
      if (paid !== true) throw new Error('Payment has not been confirmed');
      record.paidConfirmed = true;
      save(record);
    }
    if (!record.texasConfirmed) {
      record.step = 'assign_texas';
      save(record);
      await handlers.move(record.shopifyOrder.id, record.shopifyOrder.name);
      record.texasConfirmed = true;
      save(record);
    }
    record.state = 'complete';
    record.step = 'complete';
    record.lastError = null;
    record.order = null; // Remove raw customer-address XML data once completed.
    save(record);
    emit(handlers.log, record, 'success', `Completed Tradebyte import ${record.shopifyOrder.name}`);
    return record.shopifyOrder;
  } catch (error) {
    record = read(key); // Preserve any creation checkpoint written in create().
    if (error.creationRejected && !record.shopifyOrder) record.dispatched = false;
    const uncertain = !record.shopifyOrder && record.dispatched;
    record.state = (uncertain || error.manualReview || record.attempts >= MAX_ATTEMPTS)
      ? 'manual_review' : 'pending';
    record.nextAttemptAt = Date.now() + DELAY_MS;
    record.lastError = error.message;
    save(record);
    emit(handlers.log, record, 'error',
      `${record.state === 'pending' ? 'Queued retry' : 'Manual review required'} for TB.One ${key}`);
    return null;
  }
}
async function runPending(handlers) {
  for (const filename of fs.readdirSync(directory)) {
    if (!/^tb-\d+\.json$/.test(filename)) continue;
    const record = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    if (!['pending', 'running'].includes(record.state) || !record.order) continue;
    await processOrder(record.order, handlers);
  }
}
module.exports = {
  processOrder, runPending, markCreateDispatched, rememberCreated, creationRejected
};
