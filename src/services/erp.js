require("dotenv").config();
const axios = require("axios");
const logger = require("./logger");

/**
 * Client for the third-party ERP REST API.
 *
 * In production this hits ERP_BASE_URL. For local dev / testing, swap in
 * MockErpServer which provides in-memory state and the same interface.
 */
class ErpService {
  constructor() {
    this.baseUrl = process.env.ERP_BASE_URL || "https://mock-erp.internal/api/v1";
    this.apiKey = process.env.ERP_API_KEY || "";
    this.warehouseId = process.env.ERP_WAREHOUSE_ID || "WH-001";

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        "X-ERP-API-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });

    this.client.interceptors.request.use((config) => {
      logger.debug("ERP outbound request", { method: config.method, url: config.url });
      return config;
    });

    this.client.interceptors.response.use(
      (res) => {
        logger.debug("ERP response", { status: res.status, url: res.config.url });
        return res;
      },
      (err) => {
        logger.error("ERP request failed", {
          url: err.config?.url,
          status: err.response?.status,
          message: err.message,
        });
        return Promise.reject(err);
      }
    );
  }

  /**
   * Maps a Shopify order to the ERP PurchaseOrder schema and submits it.
   * @param {Object} shopifyOrder - Raw Shopify order object
   * @returns {{ success: boolean, data?: { erp_order_id: string }, error?: string }}
   */
  async createOrder(shopifyOrder) {
    const erpOrder = this._mapShopifyOrderToErp(shopifyOrder);
    try {
      const { data } = await this.client.post("/orders", erpOrder);
      logger.info("ERP order created", {
        shopifyOrderId: shopifyOrder.id,
        erpOrderId: data.order_id,
      });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /** @returns {{ success: boolean, data?: Object, error?: string }} */
  async getOrderStatus(erpOrderId) {
    try {
      const { data } = await this.client.get(`/orders/${erpOrderId}`);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Notify ERP of a stock update originating from Shopify.
   * ERP may respond with a corrected quantity (ERP is source of truth).
   */
  async updateStock(sku, warehouseId, quantity) {
    try {
      const { data } = await this.client.put(`/inventory/${encodeURIComponent(sku)}`, {
        warehouse_id: warehouseId || this.warehouseId,
        quantity,
        source: "shopify",
      });
      logger.info("ERP stock updated", { sku, quantity, corrected: data.corrected_quantity });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Bulk-fetch current ERP stock levels for an array of SKUs.
   * @param {string[]} skus
   * @returns {{ success: boolean, data?: Array<{ sku: string, quantity: number }>, error?: string }}
   */
  async getStockLevels(skus) {
    try {
      const { data } = await this.client.post("/inventory/bulk", {
        skus,
        warehouse_id: this.warehouseId,
      });
      return { success: true, data: data.inventory };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /** Transform Shopify order → ERP PurchaseOrder schema */
  _mapShopifyOrderToErp(order) {
    return {
      external_ref: String(order.id),
      order_number: order.order_number,
      order_date: order.created_at,
      status: "pending_fulfillment",
      warehouse_id: this.warehouseId,
      customer: {
        external_id: order.customer?.id ? String(order.customer.id) : null,
        email: order.email,
        name: order.customer
          ? `${order.customer.first_name} ${order.customer.last_name}`.trim()
          : order.shipping_address?.name,
      },
      shipping_address: order.shipping_address
        ? {
            name: order.shipping_address.name,
            line1: order.shipping_address.address1,
            line2: order.shipping_address.address2,
            city: order.shipping_address.city,
            province: order.shipping_address.province_code,
            postal_code: order.shipping_address.zip,
            country: order.shipping_address.country_code,
            phone: order.shipping_address.phone,
          }
        : null,
      line_items: order.line_items.map((item) => ({
        sku: item.sku,
        title: item.title,
        quantity: item.quantity,
        unit_price: parseFloat(item.price),
        variant_id: String(item.variant_id),
      })),
      totals: {
        subtotal: parseFloat(order.subtotal_price),
        shipping: parseFloat(order.total_shipping_price_set?.shop_money?.amount ?? "0"),
        tax: parseFloat(order.total_tax),
        total: parseFloat(order.total_price),
        currency: order.currency,
      },
    };
  }
}

// ─── In-memory mock for local dev and unit tests ───────────────────────────

class MockErpServer {
  constructor() {
    this._orders = new Map();
    this._inventory = new Map();
    this._nextOrderId = 1000;

    // Seed some inventory
    ["SHIRT-S", "SHIRT-M", "SHIRT-L", "PANT-S", "PANT-M"].forEach((sku, i) => {
      this._inventory.set(sku, { sku, quantity: (i + 1) * 10, warehouse_id: "WH-001" });
    });
  }

  async createOrder(shopifyOrder) {
    const erpOrderId = `ERP-${++this._nextOrderId}`;
    const order = {
      order_id: erpOrderId,
      external_ref: String(shopifyOrder.id),
      status: "pending_fulfillment",
      created_at: new Date().toISOString(),
    };
    this._orders.set(erpOrderId, order);
    logger.info("[MockERP] Order created", { erpOrderId });
    return { success: true, data: order };
  }

  async getOrderStatus(erpOrderId) {
    const order = this._orders.get(erpOrderId);
    if (!order) return { success: false, error: "Order not found" };
    return { success: true, data: order };
  }

  async updateStock(sku, warehouseId, quantity) {
    const current = this._inventory.get(sku) ?? { sku, quantity: 0, warehouse_id: warehouseId };
    // Mock: ERP corrects any quantity > 50 back to 50
    const corrected_quantity = Math.min(quantity, 50);
    this._inventory.set(sku, { ...current, quantity: corrected_quantity });
    logger.info("[MockERP] Stock updated", { sku, quantity, corrected_quantity });
    return { success: true, data: { sku, quantity: corrected_quantity, corrected_quantity } };
  }

  async getStockLevels(skus) {
    const inventory = skus.map((sku) => {
      const record = this._inventory.get(sku);
      return record ?? { sku, quantity: 0, warehouse_id: "WH-001" };
    });
    return { success: true, data: inventory };
  }
}

const instance = process.env.NODE_ENV === "test"
  ? new MockErpServer()
  : new ErpService();

module.exports = instance;
module.exports.ErpService = ErpService;
module.exports.MockErpServer = MockErpServer;
