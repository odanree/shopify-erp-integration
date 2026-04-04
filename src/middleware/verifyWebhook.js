const crypto = require("crypto");
const logger = require("../services/logger");

/**
 * Verifies Shopify webhook HMAC signature.
 *
 * Shopify sends X-Shopify-Hmac-Sha256: base64(HMAC-SHA256(rawBody, secret)).
 * We must read the raw body before any JSON parsing, so Express is configured
 * with a `verify` callback on the json() middleware that stashes the raw buffer.
 */
function verifyWebhook(req, res, next) {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  if (!hmacHeader) {
    logger.warn("Webhook request missing X-Shopify-Hmac-Sha256 header", {
      path: req.path,
      ip: req.ip,
    });
    return res.status(401).json({ error: "Missing HMAC header" });
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    logger.error("rawBody not available — ensure Express json() uses verify callback");
    return res.status(500).json({ error: "Internal configuration error" });
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    logger.error("SHOPIFY_WEBHOOK_SECRET env var not set");
    return res.status(500).json({ error: "Webhook secret not configured" });
  }

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  // Timing-safe comparison to prevent timing attacks
  let valid = false;
  try {
    valid = crypto.timingSafeEqual(
      Buffer.from(digest, "base64"),
      Buffer.from(hmacHeader, "base64")
    );
  } catch {
    // Buffer lengths differ — invalid HMAC
    valid = false;
  }

  if (!valid) {
    logger.warn("Webhook HMAC verification failed", {
      path: req.path,
      topic: req.headers["x-shopify-topic"],
      shop: req.headers["x-shopify-shop-domain"],
    });
    return res.status(401).json({ error: "HMAC verification failed" });
  }

  logger.debug("Webhook HMAC verified", {
    topic: req.headers["x-shopify-topic"],
    shop: req.headers["x-shopify-shop-domain"],
  });

  next();
}

module.exports = verifyWebhook;
