/**
 * Tests for ErpService using MockErpServer.
 * NODE_ENV=test is set which causes erp.js to export MockErpServer automatically.
 */

// Ensure test mode
process.env.NODE_ENV = "test";

const { MockErpServer } = require("../src/services/erp");

describe("MockErpServer", () => {
  let erp;

  beforeEach(() => {
    erp = new MockErpServer();
  });

  const baseOrder = {
    id: 1001,
    order_number: 1001,
    created_at: "2024-01-15T10:00:00Z",
    email: "test@example.com",
    total_price: "99.00",
    subtotal_price: "89.00",
    total_tax: "10.00",
    currency: "USD",
    customer: { id: 500, first_name: "Test", last_name: "User" },
    shipping_address: {
      name: "Test User",
      address1: "1 Test St",
      city: "NY",
      province_code: "NY",
      zip: "10001",
      country_code: "US",
      phone: null,
    },
    line_items: [
      { sku: "SHIRT-S", title: "Test Shirt", quantity: 1, price: "89.00", variant_id: 1 },
    ],
    total_shipping_price_set: { shop_money: { amount: "10.00" } },
  };

  describe("createOrder", () => {
    it("creates an order and returns an ERP order ID", async () => {
      const result = await erp.createOrder(baseOrder);
      expect(result.success).toBe(true);
      expect(result.data.order_id).toMatch(/^ERP-/);
      expect(result.data.external_ref).toBe(String(baseOrder.id));
    });

    it("assigns sequential ERP order IDs", async () => {
      const r1 = await erp.createOrder({ ...baseOrder, id: 1001 });
      const r2 = await erp.createOrder({ ...baseOrder, id: 1002 });
      expect(r1.data.order_id).not.toBe(r2.data.order_id);
    });
  });

  describe("getOrderStatus", () => {
    it("returns the order after it has been created", async () => {
      const created = await erp.createOrder(baseOrder);
      const status = await erp.getOrderStatus(created.data.order_id);
      expect(status.success).toBe(true);
      expect(status.data.order_id).toBe(created.data.order_id);
    });

    it("returns failure for unknown order ID", async () => {
      const result = await erp.getOrderStatus("ERP-NOTEXIST");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });
  });

  describe("updateStock", () => {
    it("updates inventory and returns corrected quantity", async () => {
      const result = await erp.updateStock("SHIRT-M", "WH-001", 30);
      expect(result.success).toBe(true);
      expect(result.data.sku).toBe("SHIRT-M");
      expect(result.data.quantity).toBe(30);
    });

    it("caps quantity at 50 (mock ERP business rule)", async () => {
      const result = await erp.updateStock("SHIRT-M", "WH-001", 75);
      expect(result.success).toBe(true);
      expect(result.data.quantity).toBe(50);
      expect(result.data.corrected_quantity).toBe(50);
    });

    it("creates a new SKU entry if it does not exist", async () => {
      const result = await erp.updateStock("NEW-SKU-001", "WH-001", 5);
      expect(result.success).toBe(true);
      expect(result.data.sku).toBe("NEW-SKU-001");
    });
  });

  describe("getStockLevels", () => {
    it("returns stock levels for known SKUs", async () => {
      const result = await erp.getStockLevels(["SHIRT-S", "SHIRT-M"]);
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      const skus = result.data.map((e) => e.sku);
      expect(skus).toContain("SHIRT-S");
      expect(skus).toContain("SHIRT-M");
    });

    it("returns zero quantity for unknown SKUs", async () => {
      const result = await erp.getStockLevels(["UNKNOWN-SKU"]);
      expect(result.success).toBe(true);
      expect(result.data[0].sku).toBe("UNKNOWN-SKU");
      expect(result.data[0].quantity).toBe(0);
    });

    it("handles an empty SKU list", async () => {
      const result = await erp.getStockLevels([]);
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(0);
    });
  });
});
