# ADR 004 — Dual Deployment: Lambda + Standalone Express

**Status:** Accepted  
**Date:** 2026-04-01

## Context

The integration needs to run in two contexts: AWS Lambda (production, scale-to-zero cost model) and a standalone Docker container (local development, teams without AWS accounts). Maintaining two separate codebases or separate entry points with duplicated routing logic is wasteful.

## Decision

The Express app is the single source of truth for all business logic and routing. The Lambda module in `lambda/handler.js` wraps it via `serverless-http`, which translates API Gateway events into Express-compatible request/response objects.

Two Lambda functions are exported:
- `handler` — wraps the Express app for HTTP (API Gateway)
- `syncInventory` — standalone async function for the EventBridge scheduled reconciliation job (doesn't need Express)

## Consequences

- **Positive:** Zero code duplication — Express routes serve both Lambda and Docker
- **Positive:** Local development with `docker-compose` mirrors Lambda behavior exactly
- **Negative:** `serverless-http` adds a thin abstraction layer; edge cases (streaming, WebSockets) are not supported — not needed here
- **Negative:** Lambda cold starts include Express app initialization; acceptable for webhook workloads where latency spikes are non-critical
