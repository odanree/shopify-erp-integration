/**
 * AWS Lambda entry point.
 *
 * Two exported handlers:
 *
 *  1. `handler`       — wraps the Express app via serverless-http.
 *                       Triggered by API Gateway / Lambda Function URL.
 *
 *  2. `syncInventory` — standalone handler for EventBridge scheduled trigger.
 *                       Run on a schedule (e.g. every hour) to reconcile
 *                       ERP vs Shopify inventory.
 */

// Prevent Lambda from waiting for the event loop to drain on each invocation.
// Our async services (axios, etc.) may leave open sockets.

const serverless = require("serverless-http");
const app = require("../src/app");
const inventorySync = require("../src/sync/inventorySync");
const dlqWorker = require("../src/workers/dlqWorker");
const logger = require("../src/services/logger");

// ─── HTTP handler (API Gateway / Function URL) ────────────────────────────

const _serverlessHandler = serverless(app, {
  // Preserve raw body for HMAC verification
  request(request, event) {
    if (event.body) {
      request.rawBody = Buffer.from(
        event.body,
        event.isBase64Encoded ? "base64" : "utf8"
      );
    }
  },
});

async function handler(event, context) {
  context.callbackWaitsForEmptyEventLoop = false;

  logger.info("Lambda HTTP invocation", {
    path: event.path || event.rawPath,
    method: event.httpMethod || event.requestContext?.http?.method,
    requestId: context.awsRequestId,
  });

  return _serverlessHandler(event, context);
}

// ─── Scheduled DLQ retry handler (EventBridge cron) ──────────────────────

async function retryDlqHandler(event, context) {
  context.callbackWaitsForEmptyEventLoop = false;
  logger.info("Scheduled DLQ retry Lambda invocation", { requestId: context.awsRequestId });
  try {
    await dlqWorker.processOnce();
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    logger.error("DLQ retry Lambda failed", { error: err.message });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
}

// ─── Scheduled inventory sync handler (EventBridge cron) ─────────────────

async function syncInventoryHandler(event, context) {
  context.callbackWaitsForEmptyEventLoop = false;

  logger.info("Scheduled inventory sync Lambda invocation", {
    requestId: context.awsRequestId,
    source: event.source,
    time: event.time,
  });

  try {
    const summary = await inventorySync.run();
    logger.info("Scheduled inventory sync complete", summary);
    return { statusCode: 200, body: JSON.stringify({ ok: true, summary }) };
  } catch (err) {
    logger.error("Scheduled inventory sync failed", { error: err.message });
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
}

module.exports = { handler, syncInventory: syncInventoryHandler, retryDlq: retryDlqHandler };
