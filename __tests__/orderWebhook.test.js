const request = require("supertest");
const crypto = require("crypto");
const app = require("../src/app");

// Mock services so tests don't hit real APIs
jest.mock("../src/services/erp");
jest.mock("../src/services/shopify");

const erp = require("../src/services/erp");
const shopify = require("../src/services/shopify");

const WEBHOOK_SECRET = "test_webhook_secret";

beforeAll(() => {
  process.env.SHOPIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

afterEach(() => {
  jest.clearAllMocks();
});

function buildHmac(body) {
  return crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(body)
    .digest("base64");
}

const sampleOrder = {
  id: 4501234567890,
  order_number: 1042,
  email: "customer@example.com",
  created_at: "2024-01-15T10:00:00Z",
  total_price: "129.99",
  subtotal_price: "119.99",
  total_tax: "10.00",
  currency: "USD",
  financial_status: "paid",
  fulfillment_status: null,
  customer: { id: 7890, first_name: "Alex", last_name: "Jordan" },
  shipping_address: {
    name: "Alex Jordan",
    address1: "123 Main St",
    city: "Los Angeles",
    province_code: "CA",
    zip: "90001",
    country_code: "US",
    phone: "555-555-1234",
  },
  line_items: [
    { id: 1, sku: "SHIRT-M", title: "Classic Tee", quantity: 2, price: "49.99", variant_id: 111 },
    { id: 2, sku: "PANT-L", title: "Slim Chino", quantity: 1, price: "79.99", variant_id: 222 },
  ],
  total_shipping_price_set: { shop_money: { amount: "10.00" } },
};

describe("POST /api/webhooks/orders/create", () => {
  it("returns 200 immediately and syncs order to ERP", async () => {
    erp.createOrder.mockResolvedValue({ success: true, data: { order_id: "ERP-1001" } });
    shopify.updateOrderTags.mockResolvedValue({});
    shopify.addOrderNoteAttribute.mockResolvedValue({});

    const body = JSON.stringify(sampleOrder);
    const hmac = buildHmac(body);

    const res = await request(app)
      .post("/api/webhooks/orders/create")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", hmac)
      .set("X-Shopify-Topic", "orders/create")
      .set("X-Shopify-Shop-Domain", "test-store.myshopify.com")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    // Give the async processing a tick to run
    await new Promise((r) => setImmediate(r));

    expect(erp.createOrder).toHaveBeenCalledTimes(1);
    const erpCall = erp.createOrder.mock.calls[0][0];
    expect(erpCall.external_ref).toBe(String(sampleOrder.id));
    expect(erpCall.line_items).toHaveLength(2);
    expect(erpCall.line_items[0].sku).toBe("SHIRT-M");
  });

  it("returns 401 when HMAC header is missing", async () => {
    const body = JSON.stringify(sampleOrder);
    const res = await request(app)
      .post("/api/webhooks/orders/create")
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    expect(erp.createOrder).not.toHaveBeenCalled();
  });

  it("returns 401 when HMAC is invalid", async () => {
    const body = JSON.stringify(sampleOrder);
    const res = await request(app)
      .post("/api/webhooks/orders/create")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", "invalidsignature==")
      .send(body);

    expect(res.status).toBe(401);
    expect(erp.createOrder).not.toHaveBeenCalled();
  });

  it("still returns 200 when ERP fails (fire-and-forget)", async () => {
    erp.createOrder.mockResolvedValue({ success: false, error: "ERP unavailable" });

    const body = JSON.stringify(sampleOrder);
    const hmac = buildHmac(body);

    const res = await request(app)
      .post("/api/webhooks/orders/create")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", hmac)
      .set("X-Shopify-Topic", "orders/create")
      .send(body);

    // Shopify must get 200 regardless of ERP state
    expect(res.status).toBe(200);
  });

  it("maps Shopify order fields correctly to ERP schema", async () => {
    erp.createOrder.mockResolvedValue({ success: true, data: { order_id: "ERP-1002" } });
    shopify.updateOrderTags.mockResolvedValue({});
    shopify.addOrderNoteAttribute.mockResolvedValue({});

    const body = JSON.stringify(sampleOrder);
    const hmac = buildHmac(body);

    await request(app)
      .post("/api/webhooks/orders/create")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", hmac)
      .send(body);

    await new Promise((r) => setImmediate(r));

    const erpCall = erp.createOrder.mock.calls[0][0];
    expect(erpCall.customer.email).toBe("customer@example.com");
    expect(erpCall.shipping_address.postal_code).toBe("90001");
    expect(erpCall.totals.total).toBe(129.99);
    expect(erpCall.totals.currency).toBe("USD");
  });
});
