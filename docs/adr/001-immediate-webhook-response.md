# ADR 001 — Immediate 200 Response for Webhook Handlers

**Status:** Accepted  
**Date:** 2026-04-01

## Context

Shopify requires webhook endpoints to respond within 5 seconds or it marks the delivery as failed and begins retry attempts. ERP API calls, Shopify Admin API calls, and any downstream processing can easily exceed 5 seconds under normal load or transient ERP slowness.

## Decision

All webhook handlers respond with `200 OK` immediately after HMAC verification, then process asynchronously in a detached promise (no `await` on the processing chain after responding).

## Consequences

- **Positive:** Shopify never sees a timeout failure regardless of ERP latency
- **Positive:** Retry storms from Shopify are eliminated — each event is acknowledged exactly once
- **Negative:** Processing errors (ERP unreachable, mapping failures) are invisible to Shopify — logged only; Shopify marks the delivery as successful regardless
- **Negative:** No built-in retry for failed async processing; a production system would push failed events to a dead-letter queue (noted in code comments but not implemented)
