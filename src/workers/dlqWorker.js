const dlq = require("../services/dlq");
const erp = require("../services/erp");
const shopify = require("../services/shopify");
const logger = require("../services/logger");

const POLL_INTERVAL_MS = parseInt(process.env.DLQ_POLL_INTERVAL_MS || "60000", 10); // 1 min

let _timer = null;

/**
 * Processes one pass of the DLQ: retries all items whose backoff window
 * has elapsed, then acks on success or nacks on failure.
 */
async function processOnce() {
  const items = dlq.drainRetryable();
  if (!items.length) return;

  logger.info(`DLQ worker: processing ${items.length} retryable item(s)`);

  await Promise.allSettled(
    items.map(async (item) => {
      try {
        if (item.type === "order_sync") {
          await _retryOrderSync(item);
        } else if (item.type === "inventory_update") {
          await _retryInventoryUpdate(item);
        } else {
          logger.warn("DLQ worker: unknown item type — acking to prevent loop", {
            id: item.id,
            type: item.type,
          });
          dlq.ack(item.id);
        }
      } catch (err) {
        // Unexpected throw (not from ERP service) — nack with the raw error
        dlq.nack(item.id, err.message);
      }
    })
  );
}

async function _retryOrderSync(item) {
  const { order } = item.payload;

  const erpResult = await erp.createOrder(order);
  if (!erpResult.success) {
    dlq.nack(item.id, erpResult.error);
    return;
  }

  const erpOrderId = erpResult.data.order_id;

  await Promise.allSettled([
    shopify.updateOrderTags(order.id, ["erp-synced"]),
    shopify.addOrderNoteAttribute(order.id, "erp_order_id", erpOrderId),
  ]);

  dlq.ack(item.id);
  logger.info("DLQ retry succeeded: order_sync", {
    dlqItemId: item.id,
    shopifyOrderId: order.id,
    erpOrderId,
    totalAttempts: item.attempts,
  });
}

async function _retryInventoryUpdate(item) {
  const { sku, warehouseId, quantity } = item.payload;

  const erpResult = await erp.updateStock(sku, warehouseId, quantity);
  if (!erpResult.success) {
    dlq.nack(item.id, erpResult.error);
    return;
  }

  dlq.ack(item.id);
  logger.info("DLQ retry succeeded: inventory_update", {
    dlqItemId: item.id,
    sku,
    totalAttempts: item.attempts,
  });
}

/** Start the background polling loop. Safe to call multiple times. */
function start() {
  if (_timer) return;
  logger.info(`DLQ worker started (poll interval: ${POLL_INTERVAL_MS}ms)`);
  _timer = setInterval(() => {
    processOnce().catch((err) =>
      logger.error("DLQ worker poll error", { error: err.message })
    );
  }, POLL_INTERVAL_MS);
  // Unref so the timer doesn't keep the process alive if nothing else is running
  _timer.unref();
}

/** Stop the background polling loop. */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info("DLQ worker stopped");
  }
}

module.exports = { start, stop, processOnce };
