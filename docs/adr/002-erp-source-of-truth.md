# ADR 002 — ERP as Source of Truth for Inventory

**Status:** Accepted  
**Date:** 2026-04-01

## Context

Merchants operating across multiple sales channels (Shopify, wholesale, POS) risk inventory inconsistency if each channel manages its own stock counts independently. A Shopify `inventory_levels/update` event could reflect a channel-specific adjustment that contradicts the ERP's view of actual warehouse stock.

## Decision

The ERP is the authoritative source for inventory quantities. When a Shopify inventory webhook arrives:

1. The current level is forwarded to ERP
2. If ERP returns a corrected quantity (differing from what Shopify sent), the system writes the correction back to Shopify via `inventory_levels/set`

Shopify is the source of truth only for orders.

## Consequences

- **Positive:** Inventory stays consistent across all channels; ERP governs all stock decisions
- **Positive:** Merchants can adjust stock in ERP without manual Shopify sync
- **Negative:** ERP downtime blocks inventory corrections — the webhook acknowledges (200) but no correction is written; a scheduled reconciliation job (`inventorySync`) covers this gap with hourly catch-up
- **Negative:** Location mapping is simplified (`SHOPIFY_LOCATION_ID` env var); multi-warehouse ERP setups would require warehouse→location mapping logic
