# shopify-erp-integration

Real-time webhook-driven sync between Shopify and a third-party ERP. Processes `orders/create` and `inventory_levels/update` webhooks, forwards to ERP, and writes ERP corrections back to Shopify. Ships as both a standalone Express server and an AWS Lambda function with EventBridge-scheduled reconciliation.

---

## Architecture

```
Shopify ──webhook──► Express/Lambda ──► ERP API
                          │
                          └──► Shopify Admin API (inventory corrections)
```

- **Order sync**: Shopify fires `orders/create` → handler responds immediately (Shopify 5s timeout) → async POST to ERP → tag order `erp-synced`
- **Inventory sync (webhook)**: `inventory_levels/update` → forward to ERP → ERP corrects quantity → write back to Shopify
- **Inventory sync (scheduled)**: EventBridge every hour → fetch active SKUs from open orders → bulk-compare Shopify vs ERP → correct discrepancies
- **ERP is source of truth** for inventory; Shopify is source of truth for orders

---

## Stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js 18+ |
| Framework | Express.js |
| Deployment | AWS Lambda (Serverless Framework) + standalone Docker |
| HTTP client | Axios with exponential backoff on 429 |
| Logging | Winston (JSON in prod, colored in dev) |
| Testing | Jest + Supertest |

---

## Local development

```bash
# Start app + mock ERP
docker-compose up

# App: http://localhost:3000
# Mock ERP: http://localhost:4000

# Run tests
npm test
```

---

## Environment variables

See `.env.example` for all required variables. Key ones:

| Variable | Description |
|----------|-------------|
| `SHOPIFY_SHOP_DOMAIN` | `your-store.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | Admin API token |
| `SHOPIFY_WEBHOOK_SECRET` | Webhook HMAC signing secret |
| `ERP_API_URL` | ERP base URL |
| `ERP_API_KEY` | ERP auth key |
| `SHOPIFY_LOCATION_ID` | Shopify location ID for inventory updates |

---

## Deployment

```bash
# Deploy to AWS Lambda
npm run deploy

# Or run as standalone Express
npm start
```

The Lambda module exports two handlers:
- `handler` — HTTP API Gateway (order/inventory webhooks)
- `syncInventory` — EventBridge scheduled reconciliation

---

## Design decisions

See [`docs/adr/`](docs/adr/) for full decision records. Key choices:

- **Immediate 200 response**: Shopify has a strict 5s webhook timeout; all processing is async after the response
- **ERP as inventory source of truth**: Prevents multi-channel inconsistency; ERP can override Shopify quantities
- **Raw body capture**: HMAC verification requires the raw request bytes before `express.json()` parsing consumes them
- **Dual deployment**: Single codebase ships both modes via `serverless-http` adapter; no code duplication
