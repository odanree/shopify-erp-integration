require("dotenv").config();
const axios = require("axios");
const logger = require("./logger");

const SHOPIFY_API_VERSION = "2024-01";

/**
 * Thin wrapper around the Shopify Admin REST API.
 * Handles authorization, rate-limit retries, and request logging.
 */
class ShopifyService {
  constructor() {
    const shop = process.env.SHOPIFY_SHOP_DOMAIN;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!shop || !token) {
      throw new Error("SHOPIFY_SHOP_DOMAIN and SHOPIFY_ACCESS_TOKEN must be set");
    }
    this.baseUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}`;
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    });
    this._attachRetryInterceptor();
  }

  /** Exponential-backoff retry on 429 Too Many Requests */
  _attachRetryInterceptor() {
    this.client.interceptors.response.use(
      (res) => res,
      async (err) => {
        const config = err.config;
        const status = err.response?.status;
        config._retryCount = config._retryCount ?? 0;

        if (status === 429 && config._retryCount < 3) {
          config._retryCount += 1;
          const retryAfter = parseInt(err.response.headers["retry-after"] ?? "2", 10);
          logger.warn(`Shopify rate limit hit. Retrying in ${retryAfter}s`, {
            attempt: config._retryCount,
            url: config.url,
          });
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          return this.client(config);
        }
        return Promise.reject(err);
      }
    );
  }

  /** GET a single order */
  async getOrder(orderId) {
    const { data } = await this.client.get(`/orders/${orderId}.json`);
    return data.order;
  }

  /** GET unfulfilled paid orders — source for ERP sync */
  async getPendingOrders() {
    const { data } = await this.client.get("/orders.json", {
      params: {
        financial_status: "paid",
        fulfillment_status: "unfulfilled",
        status: "open",
        limit: 250,
      },
    });
    return data.orders;
  }

  /** Add a tag to an order (preserves existing tags) */
  async updateOrderTags(orderId, additionalTags) {
    const order = await this.getOrder(orderId);
    const existing = order.tags ? order.tags.split(", ").map((t) => t.trim()) : [];
    const merged = [...new Set([...existing, ...additionalTags])].join(", ");
    const { data } = await this.client.put(`/orders/${orderId}.json`, {
      order: { id: orderId, tags: merged },
    });
    logger.info("Updated order tags", { orderId, tags: merged });
    return data.order;
  }

  /** Append a note attribute to an order */
  async addOrderNoteAttribute(orderId, key, value) {
    const order = await this.getOrder(orderId);
    const existing = order.note_attributes ?? [];
    const filtered = existing.filter((a) => a.name !== key);
    const updated = [...filtered, { name: key, value }];
    const { data } = await this.client.put(`/orders/${orderId}.json`, {
      order: { id: orderId, note_attributes: updated },
    });
    logger.info("Added order note attribute", { orderId, key, value });
    return data.order;
  }

  /** GET inventory item by ID (used to resolve SKU from inventory_item_id) */
  async getInventoryItem(inventoryItemId) {
    const { data } = await this.client.get(
      `/inventory_items/${inventoryItemId}.json`
    );
    return data.inventory_item;
  }

  /** Set inventory level for a given item and location */
  async setInventoryLevel(inventoryItemId, locationId, available) {
    const { data } = await this.client.post("/inventory_levels/set.json", {
      inventory_item_id: inventoryItemId,
      location_id: locationId,
      available,
    });
    logger.info("Set Shopify inventory level", {
      inventoryItemId,
      locationId,
      available,
    });
    return data.inventory_level;
  }

  /**
   * Find a product variant by SKU using the GraphQL Admin API.
   * Returns { id, sku, inventoryItemId } or null.
   */
  async getProductVariantBySku(sku) {
    const shop = process.env.SHOPIFY_SHOP_DOMAIN;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

    const query = `
      query getVariantBySku($query: String!) {
        productVariants(first: 1, query: $query) {
          edges {
            node {
              id
              sku
              inventoryItem {
                id
              }
            }
          }
        }
      }
    `;

    const { data } = await axios.post(
      url,
      { query, variables: { query: `sku:${sku}` } },
      {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
      }
    );

    const edges = data.data?.productVariants?.edges ?? [];
    if (!edges.length) return null;
    const node = edges[0].node;
    return {
      id: node.id,
      sku: node.sku,
      inventoryItemId: node.inventoryItem.id.replace("gid://shopify/InventoryItem/", ""),
    };
  }
}

module.exports = new ShopifyService();
