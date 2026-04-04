const { randomUUID } = require("crypto");
const logger = require("./logger");

/**
 * In-process Dead-Letter Queue for failed ERP sync operations.
 *
 * Stores failed items in memory with retry metadata. Designed so the
 * interface is identical to what you'd swap in for an SQS-backed DLQ:
 *   - push(payload)     → enqueue a failed item
 *   - drainRetryable()  → return items ready for retry (respects backoff)
 *   - ack(id)           → remove a successfully retried item
 *   - nack(id, error)   → record another failure, increment attempt count
 *   - status()          → summary stats for the /api/dlq/status endpoint
 *
 * Production swap-in: replace push/drainRetryable/ack/nack with
 * SQS SendMessage / ReceiveMessage / DeleteMessage / ChangeMessageVisibility.
 *
 * Limits:
 *   - MAX_ITEMS: shed load if the ERP is down for a long time
 *   - MAX_ATTEMPTS: stop retrying after N failures (item moves to dead state)
 *   - BASE_DELAY_MS: first retry after 30s, doubles each attempt (capped at 1h)
 */

const MAX_ITEMS = parseInt(process.env.DLQ_MAX_ITEMS || "500", 10);
const MAX_ATTEMPTS = parseInt(process.env.DLQ_MAX_ATTEMPTS || "5", 10);
const BASE_DELAY_MS = parseInt(process.env.DLQ_BASE_DELAY_MS || "30000", 10); // 30s

class DeadLetterQueue {
  constructor() {
    /** @type {Map<string, DlqItem>} */
    this._items = new Map();
  }

  /**
   * Enqueue a failed operation.
   * @param {{ type: string, payload: object, error: string }} opts
   * @returns {string} item ID
   */
  push({ type, payload, error }) {
    if (this._items.size >= MAX_ITEMS) {
      logger.error("DLQ full — dropping item", { type, maxItems: MAX_ITEMS });
      return null;
    }

    const id = randomUUID();
    const item = {
      id,
      type,          // e.g. "order_sync", "inventory_update"
      payload,       // original data needed to retry
      attempts: 1,
      lastError: error,
      firstFailedAt: new Date().toISOString(),
      nextRetryAt: this._nextRetryTime(1),
      dead: false,
    };

    this._items.set(id, item);
    logger.warn("DLQ item enqueued", {
      id,
      type,
      attempts: item.attempts,
      nextRetryAt: item.nextRetryAt,
    });
    return id;
  }

  /**
   * Returns all items whose nextRetryAt has passed and that haven't
   * exceeded MAX_ATTEMPTS. Does NOT remove them (caller must ack/nack).
   * @returns {DlqItem[]}
   */
  drainRetryable() {
    const now = Date.now();
    return [...this._items.values()].filter(
      (item) => !item.dead && new Date(item.nextRetryAt).getTime() <= now
    );
  }

  /**
   * Remove a successfully retried item.
   * @param {string} id
   */
  ack(id) {
    if (this._items.delete(id)) {
      logger.info("DLQ item acked (retry succeeded)", { id });
    }
  }

  /**
   * Record another failure. If MAX_ATTEMPTS exceeded, mark dead.
   * @param {string} id
   * @param {string} error
   */
  nack(id, error) {
    const item = this._items.get(id);
    if (!item) return;

    item.attempts += 1;
    item.lastError = error;

    if (item.attempts >= MAX_ATTEMPTS) {
      item.dead = true;
      logger.error("DLQ item marked dead — max attempts reached", {
        id,
        type: item.type,
        attempts: item.attempts,
        firstFailedAt: item.firstFailedAt,
        lastError: error,
      });
    } else {
      item.nextRetryAt = this._nextRetryTime(item.attempts);
      logger.warn("DLQ item nacked — will retry", {
        id,
        type: item.type,
        attempts: item.attempts,
        nextRetryAt: item.nextRetryAt,
      });
    }
  }

  /**
   * Summary stats for observability endpoint.
   */
  status() {
    const all = [...this._items.values()];
    return {
      total: all.length,
      retryable: all.filter((i) => !i.dead).length,
      dead: all.filter((i) => i.dead).length,
      items: all.map(({ id, type, attempts, dead, lastError, firstFailedAt, nextRetryAt }) => ({
        id,
        type,
        attempts,
        dead,
        lastError,
        firstFailedAt,
        nextRetryAt,
      })),
    };
  }

  /** Exponential backoff: 30s, 60s, 120s, 240s, capped at 1h */
  _nextRetryTime(attemptNumber) {
    const delayMs = Math.min(
      BASE_DELAY_MS * Math.pow(2, attemptNumber - 1),
      60 * 60 * 1000 // 1 hour cap
    );
    return new Date(Date.now() + delayMs).toISOString();
  }
}

// Singleton — shared across the entire process
const dlq = new DeadLetterQueue();
module.exports = dlq;
module.exports.DeadLetterQueue = DeadLetterQueue;
