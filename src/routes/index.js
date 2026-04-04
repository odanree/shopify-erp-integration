const { Router } = require("express");
const verifyWebhook = require("../middleware/verifyWebhook");
const { handleOrderCreate } = require("../handlers/orderWebhook");
const { handleInventoryUpdate } = require("../handlers/inventoryWebhook");
const inventorySync = require("../sync/inventorySync");
const dlq = require("../services/dlq");
const dlqWorker = require("../workers/dlqWorker");
const shopify = require("../services/shopify");
const logger = require("../services/logger");

const router = Router();

// ─── Webhooks (HMAC-verified) ─────────────────────────────────────────────

router.post(
  "/api/webhooks/orders/create",
  verifyWebhook,
  handleOrderCreate
);

router.post(
  "/api/webhooks/inventory/update",
  verifyWebhook,
  handleInventoryUpdate
);

// ─── Manual sync triggers ─────────────────────────────────────────────────

/** Trigger a full inventory reconciliation between ERP and Shopify */
router.get("/api/sync/inventory", async (req, res) => {
  logger.info("Manual inventory sync triggered via API");
  try {
    const summary = await inventorySync.run();
    res.json({ ok: true, summary });
  } catch (err) {
    logger.error("Inventory sync error", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Fetch and log pending (paid + unfulfilled) Shopify orders */
router.get("/api/sync/orders/pending", async (req, res) => {
  try {
    const orders = await shopify.getPendingOrders();
    res.json({
      ok: true,
      count: orders.length,
      orders: orders.map((o) => ({
        id: o.id,
        order_number: o.order_number,
        total_price: o.total_price,
        created_at: o.created_at,
        line_items: o.line_items.length,
      })),
    });
  } catch (err) {
    logger.error("Failed to fetch pending orders", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Dead-letter queue ────────────────────────────────────────────────────

/** View DLQ status (item counts, retry schedule) */
router.get("/api/dlq/status", (req, res) => {
  res.json({ ok: true, dlq: dlq.status() });
});

/** Immediately trigger one DLQ retry pass (useful for manual recovery) */
router.post("/api/dlq/retry", async (req, res) => {
  logger.info("Manual DLQ retry triggered via API");
  try {
    await dlqWorker.processOnce();
    res.json({ ok: true, dlq: dlq.status() });
  } catch (err) {
    logger.error("Manual DLQ retry error", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: process.env.npm_package_version || "1.0.0",
    uptime: Math.floor(process.uptime()),
    env: process.env.NODE_ENV,
  });
});

module.exports = router;
