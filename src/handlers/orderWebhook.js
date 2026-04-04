const shopify = require("../services/shopify");
const erp = require("../services/erp");
const logger = require("../services/logger");

/**
 * Handles the Shopify orders/create webhook.
 *
 * Flow:
 *  1. Parse order from request body
 *  2. Immediately respond 200 to Shopify (< 5s requirement)
 *  3. Asynchronously: send order to ERP, then tag Shopify order
 */
async function handleOrderCreate(req, res) {
  const order = req.body;

  if (!order || !order.id) {
    logger.warn("orderCreate webhook: invalid payload", { body: req.body });
    return res.status(400).json({ error: "Invalid order payload" });
  }

  const topic = req.headers["x-shopify-topic"];
  const shop = req.headers["x-shopify-shop-domain"];

  logger.info("Received order webhook", {
    topic,
    shop,
    orderId: order.id,
    orderNumber: order.order_number,
    total: order.total_price,
    lineItems: order.line_items?.length,
  });

  // Respond immediately — Shopify requires a response within 5 seconds
  res.status(200).json({ received: true });

  // Process asynchronously so we don't block
  _processOrder(order).catch((err) => {
    logger.error("Unhandled error in order processing", {
      orderId: order.id,
      error: err.message,
      stack: err.stack,
    });
  });
}

async function _processOrder(order) {
  // 1. Send order to ERP
  const erpResult = await erp.createOrder(order);

  if (!erpResult.success) {
    logger.error("Failed to create ERP order", {
      orderId: order.id,
      error: erpResult.error,
    });
    // In production: push to a dead-letter queue / retry mechanism
    return;
  }

  const erpOrderId = erpResult.data.order_id;
  logger.info("ERP order created successfully", {
    shopifyOrderId: order.id,
    erpOrderId,
  });

  // 2. Tag the Shopify order so merchants can filter by ERP-synced status
  await shopify.updateOrderTags(order.id, ["erp-synced"]).catch((err) => {
    logger.warn("Could not update order tags", { orderId: order.id, error: err.message });
  });

  // 3. Store ERP order ID as a note attribute for reference
  await shopify.addOrderNoteAttribute(order.id, "erp_order_id", erpOrderId).catch((err) => {
    logger.warn("Could not set ERP order note attribute", {
      orderId: order.id,
      error: err.message,
    });
  });

  logger.info("Order sync complete", {
    shopifyOrderId: order.id,
    erpOrderId,
  });
}

module.exports = { handleOrderCreate };
