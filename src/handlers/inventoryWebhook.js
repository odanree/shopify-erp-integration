const shopify = require("../services/shopify");
const erp = require("../services/erp");
const logger = require("../services/logger");

/**
 * Handles the Shopify inventory_levels/update webhook.
 *
 * Bidirectional sync strategy:
 *  - ERP is the source of truth for stock quantities.
 *  - When Shopify fires this webhook (e.g. merchant manual adjustment),
 *    we notify the ERP. If ERP returns a corrected_quantity, we write
 *    that back to Shopify — overriding the manual change.
 */
async function handleInventoryUpdate(req, res) {
  const level = req.body;

  if (!level || !level.inventory_item_id) {
    return res.status(400).json({ error: "Invalid inventory level payload" });
  }

  logger.info("Received inventory_levels/update webhook", {
    inventoryItemId: level.inventory_item_id,
    locationId: level.location_id,
    available: level.available,
  });

  // Respond immediately
  res.status(200).json({ received: true });

  _processInventoryUpdate(level).catch((err) => {
    logger.error("Unhandled error in inventory sync", {
      inventoryItemId: level.inventory_item_id,
      error: err.message,
    });
  });
}

async function _processInventoryUpdate(level) {
  // 1. Resolve inventory_item_id → SKU via Shopify API
  let inventoryItem;
  try {
    inventoryItem = await shopify.getInventoryItem(level.inventory_item_id);
  } catch (err) {
    logger.error("Could not fetch inventory item", {
      inventoryItemId: level.inventory_item_id,
      error: err.message,
    });
    return;
  }

  const sku = inventoryItem.sku;
  if (!sku) {
    logger.warn("Inventory item has no SKU — skipping ERP sync", {
      inventoryItemId: level.inventory_item_id,
    });
    return;
  }

  // 2. Notify ERP of the new quantity
  const erpResult = await erp.updateStock(
    sku,
    process.env.ERP_WAREHOUSE_ID,
    level.available
  );

  if (!erpResult.success) {
    logger.error("ERP stock update failed", { sku, error: erpResult.error });
    return;
  }

  // 3. If ERP corrected the quantity, write it back to Shopify
  const correctedQty = erpResult.data?.corrected_quantity;
  const hasCorrection =
    correctedQty !== undefined && correctedQty !== null && correctedQty !== level.available;

  if (hasCorrection) {
    logger.info("ERP corrected inventory quantity — writing back to Shopify", {
      sku,
      shopifyQty: level.available,
      erpQty: correctedQty,
    });

    try {
      await shopify.setInventoryLevel(
        level.inventory_item_id,
        level.location_id,
        correctedQty
      );
    } catch (err) {
      logger.error("Failed to write ERP correction back to Shopify", {
        sku,
        correctedQty,
        error: err.message,
      });
    }
  } else {
    logger.info("ERP accepted Shopify inventory level", { sku, quantity: level.available });
  }
}

module.exports = { handleInventoryUpdate };
