const shopify = require("../services/shopify");
const erp = require("../services/erp");
const logger = require("../services/logger");

/**
 * Reconciles inventory between ERP (source of truth) and Shopify.
 *
 * Steps:
 *  1. Fetch all paid+unfulfilled Shopify orders to collect active SKUs
 *  2. Fetch ERP stock levels for those SKUs
 *  3. Compare against Shopify inventory (via variant lookup)
 *  4. Apply corrections to Shopify where ERP differs beyond threshold
 */
async function run({ correctionThreshold = 0 } = {}) {
  logger.info("Starting inventory sync");
  const summary = { synced: 0, skipped: 0, errors: [] };

  // 1. Collect SKUs from pending orders
  let pendingOrders;
  try {
    pendingOrders = await shopify.getPendingOrders();
  } catch (err) {
    logger.error("Could not fetch pending orders for inventory sync", { error: err.message });
    throw err;
  }

  const skuSet = new Set();
  for (const order of pendingOrders) {
    for (const item of order.line_items) {
      if (item.sku) skuSet.add(item.sku);
    }
  }

  if (skuSet.size === 0) {
    logger.info("No active SKUs found in pending orders — sync complete", summary);
    return summary;
  }

  const skus = [...skuSet];
  logger.info(`Fetching ERP stock levels for ${skus.length} SKUs`);

  // 2. Bulk-fetch ERP stock
  const erpResult = await erp.getStockLevels(skus);
  if (!erpResult.success) {
    const msg = `ERP bulk stock fetch failed: ${erpResult.error}`;
    logger.error(msg);
    throw new Error(msg);
  }

  const erpStockMap = new Map(erpResult.data.map((e) => [e.sku, e.quantity]));

  // 3 & 4. For each SKU, look up Shopify variant and compare
  for (const sku of skus) {
    try {
      const erpQty = erpStockMap.get(sku);
      if (erpQty === undefined) {
        logger.warn("SKU not found in ERP inventory", { sku });
        summary.skipped++;
        continue;
      }

      const variant = await shopify.getProductVariantBySku(sku);
      if (!variant) {
        logger.warn("Variant not found in Shopify for SKU", { sku });
        summary.skipped++;
        continue;
      }

      // Get current Shopify inventory level
      const inventoryItem = await shopify.getInventoryItem(variant.inventoryItemId);
      const shopifyQty = inventoryItem.tracked ? undefined : null;

      const diff = Math.abs((shopifyQty ?? 0) - erpQty);
      if (diff > correctionThreshold) {
        logger.info("Inventory discrepancy — correcting Shopify", {
          sku,
          erpQty,
          shopifyQty,
          diff,
        });

        // Use first location; in production, resolve location from ERP warehouse mapping
        await shopify.setInventoryLevel(
          variant.inventoryItemId,
          process.env.SHOPIFY_LOCATION_ID || "1",
          erpQty
        );
        summary.synced++;
      } else {
        summary.skipped++;
      }
    } catch (err) {
      logger.error("Error syncing SKU", { sku, error: err.message });
      summary.errors.push({ sku, error: err.message });
    }
  }

  logger.info("Inventory sync complete", summary);
  return summary;
}

module.exports = { run };
