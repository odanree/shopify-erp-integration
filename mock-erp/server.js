/**
 * Minimal Express server simulating a third-party ERP REST API.
 * Used by docker-compose for local integration testing.
 *
 * Endpoints:
 *   GET  /health
 *   POST /api/v1/orders
 *   GET  /api/v1/orders/:id
 *   PUT  /api/v1/inventory/:sku
 *   POST /api/v1/inventory/bulk
 */

const express = require("express");
const app = express();
app.use(express.json());

const orders = new Map();
const inventory = new Map(
  ["SHIRT-S", "SHIRT-M", "SHIRT-L", "PANT-S", "PANT-M", "PANT-L"].map(
    (sku, i) => [sku, { sku, quantity: (i + 1) * 10, warehouse_id: "WH-001" }]
  )
);
let nextId = 1000;

function requireApiKey(req, res, next) {
  if (req.headers["x-erp-api-key"] !== (process.env.ERP_API_KEY || "erp_api_key_here")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "mock-erp" });
});

app.post("/api/v1/orders", requireApiKey, (req, res) => {
  const order_id = `ERP-${++nextId}`;
  const order = { order_id, ...req.body, status: "pending_fulfillment", created_at: new Date().toISOString() };
  orders.set(order_id, order);
  console.log(`[mock-erp] Order created: ${order_id}`);
  res.status(201).json(order);
});

app.get("/api/v1/orders/:id", requireApiKey, (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});

app.put("/api/v1/inventory/:sku", requireApiKey, (req, res) => {
  const { sku } = req.params;
  const { quantity } = req.body;
  const corrected_quantity = Math.min(quantity, 100); // ERP cap at 100
  inventory.set(sku, { sku, quantity: corrected_quantity, warehouse_id: req.body.warehouse_id || "WH-001" });
  console.log(`[mock-erp] Inventory updated: ${sku} = ${corrected_quantity}`);
  res.json({ sku, quantity: corrected_quantity, corrected_quantity });
});

app.post("/api/v1/inventory/bulk", requireApiKey, (req, res) => {
  const { skus } = req.body;
  const result = (skus || []).map((sku) => {
    const record = inventory.get(sku);
    return record || { sku, quantity: 0, warehouse_id: "WH-001" };
  });
  res.json({ inventory: result });
});

const PORT = 4000;
app.listen(PORT, () => console.log(`[mock-erp] Listening on port ${PORT}`));
