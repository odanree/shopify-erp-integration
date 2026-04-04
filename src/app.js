require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const logger = require("./services/logger");
const routes = require("./routes/index");
const dlqWorker = require("./workers/dlqWorker");

const app = express();

// ─── Raw body capture for HMAC webhook verification ───────────────────────
// Must be registered before any body parser middleware.
app.use((req, res, next) => {
  let data = [];
  req.on("data", (chunk) => data.push(chunk));
  req.on("end", () => {
    req.rawBody = Buffer.concat(data);
    next();
  });
});

app.use(express.json({
  verify: (req, res, buf) => {
    // Also stash via verify callback as a fallback
    if (!req.rawBody) req.rawBody = buf;
  },
}));

// ─── Request logging ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path}`, {
      status: res.statusCode,
      durationMs: duration,
      ip: req.ip,
      topic: req.headers["x-shopify-topic"],
    });
  });
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────
app.use(routes);

// ─── 404 handler ─────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Error handler ────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error("Unhandled application error", {
    error: err.message,
    stack: err.stack,
    path: req.path,
  });
  res.status(500).json({ error: "Internal server error" });
});

// ─── Start server (only when run directly, not imported by Lambda) ────────
if (require.main === module) {
  const PORT = parseInt(process.env.PORT || "3000", 10);
  app.listen(PORT, () => {
    logger.info(`shopify-erp-integration listening on port ${PORT}`, {
      env: process.env.NODE_ENV,
      shop: process.env.SHOPIFY_SHOP_DOMAIN,
    });
    dlqWorker.start();
  });
}

module.exports = app;
