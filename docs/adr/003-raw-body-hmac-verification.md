# ADR 003 — Raw Body Capture for HMAC Verification

**Status:** Accepted  
**Date:** 2026-04-01

## Context

Shopify signs every webhook with an HMAC-SHA256 header computed over the raw request body. Standard `express.json()` middleware parses and discards the raw bytes before any route handler can access them. Without the original raw body, HMAC verification is impossible.

## Decision

A custom `captureRawBody` middleware runs before `express.json()`. It accumulates request chunks into `req.rawBody`. The `verifyWebhook` middleware then computes HMAC over `req.rawBody` using timing-safe `crypto.timingSafeEqual` comparison (prevents timing attacks on the secret).

## Alternatives Considered

| Option | Rejected because |
|--------|-----------------|
| `express.json({ verify: fn })` callback | Works but poorly documented and tightly coupled to the JSON body parser — brittle if the body parser is swapped |
| Store raw body in a temp field inside express.json verify | Same approach, just different API — chosen for explicit middleware over the verify callback pattern |

## Consequences

- **Positive:** Webhook signatures are verified correctly before any processing
- **Positive:** Timing-safe comparison prevents secret extraction via timing side-channels
- **Negative:** All request bodies are buffered in memory as both raw bytes and parsed JSON — acceptable for typical Shopify webhook payloads (< 50KB)
