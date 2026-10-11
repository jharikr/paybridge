import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { type } from "arktype";
import { signWebhook } from "../../contracts/webhooks.ts";
import type { PaybridgeDatabase } from "./database.ts";

export function webhookWorkerConfig(args: string[]) {
  const [
    timeout = "3000",
    lease = "10000",
    poll = "250",
    retryBase = "1000",
    retryMax = "60000",
  ] = args;
  const config = {
    timeoutMs: type("1 <= number.integer <= 60000").assert(Number(timeout)),
    leaseMs: type("1 <= number.integer <= 300000").assert(Number(lease)),
    pollMs: type("1 <= number.integer <= 60000").assert(Number(poll)),
    retryBaseMs: type("1 <= number.integer <= 300000").assert(
      Number(retryBase),
    ),
    retryMaxMs: type("1 <= number.integer <= 3600000").assert(Number(retryMax)),
  };
  if (
    config.timeoutMs >= config.leaseMs ||
    config.retryBaseMs > config.retryMaxMs
  )
    throw new Error(
      "Webhook timing requires timeout below lease and base retry no greater than its cap",
    );
  return config;
}
type Config = ReturnType<typeof webhookWorkerConfig>;
export type WebhookCheckpoint = (event: {
  kind:
    | "after-webhook-claim"
    | "after-webhook-response"
    | "before-webhook-completion-commit";
  eventId: string;
}) => Promise<void>;
async function claimWork({
  db,
  workerId,
  config,
  now,
}: {
  db: PaybridgeDatabase;
  workerId: string;
  config: Config;
  now: () => Date;
}) {
  return db.transaction(async (tx) => {
    // Start the lease clock after SQLite grants write access.
    await tx.execute(
      db.raw.sql`UPDATE webhook_outbox SET id=id WHERE 0`
        .affectedCount()
        .build(),
    );
    const at = now();
    const expires = new Date(at.getTime() + config.leaseMs).toISOString();
    const token = randomUUID();
    const changed = await tx.execute(
      db.raw.sql`
      UPDATE webhook_outbox SET status='PROCESSING',claim_token=${token},locked_by=${workerId},lease_expires_at=${expires},attempt_count=attempt_count+1
      WHERE id=(SELECT id FROM webhook_outbox WHERE (status='PENDING' AND next_attempt_at<=${at.toISOString()}) OR (status='PROCESSING' AND lease_expires_at<=${at.toISOString()}) ORDER BY next_attempt_at,id LIMIT 1)
    `
        .affectedCount()
        .build(),
    );
    if (changed.affectedRows === 0) return null;
    const work = await tx.orm.WebhookOutbox.where({
      claimToken: token,
    }).first();
    if (!work) throw new Error("Claimed webhook work is missing");
    const merchant = await tx.orm.Merchant.where({
      id: work.merchantId,
    }).first();
    if (!merchant) throw new Error("Webhook merchant is missing");
    return { work, merchant, token, expires };
  });
}
type Claim = NonNullable<Awaited<ReturnType<typeof claimWork>>>;
async function deliver({
  claim,
  config,
  now,
}: {
  claim: Claim;
  config: Config;
  now: () => Date;
}) {
  const timestamp = String(Math.floor(now().getTime() / 1000));
  const deadline = AbortSignal.timeout(config.timeoutMs);
  try {
    const response = await fetch(claim.merchant.webhookUrl, {
      method: "POST",
      redirect: "error",
      signal: deadline,
      headers: {
        "content-type": "application/json",
        "paybridge-event-id": claim.work.paymentEventId,
        "paybridge-timestamp": timestamp,
        "paybridge-signature": signWebhook({
          timestamp,
          body: claim.work.payload,
          secret: claim.merchant.webhookSecret,
        }),
      },
      body: claim.work.payload,
    });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 300
      ? null
      : `webhook_http_${response.status}`;
  } catch {
    return deadline.aborted ? "webhook_timeout" : "webhook_transport_failure";
  }
}
async function finish({
  db,
  claim,
  workerId,
  config,
  error,
  now,
  checkpoint,
}: {
  db: PaybridgeDatabase;
  claim: Claim;
  workerId: string;
  config: Config;
  error: string | null;
  now: () => Date;
  checkpoint?: WebhookCheckpoint;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(
      db.raw.sql`UPDATE webhook_outbox SET id=id WHERE id=${claim.work.id}`
        .affectedCount()
        .build(),
    );
    const at = now();
    const backoff = Math.min(
      config.retryMaxMs,
      config.retryBaseMs * 2 ** Math.min(claim.work.attemptCount - 1, 30),
    );
    const next = new Date(at.getTime() + backoff).toISOString();
    const changed =
      error === null
        ? await tx.execute(
            db.raw
              .sql`UPDATE webhook_outbox SET status='DELIVERED',delivered_at=${at.toISOString()},last_error=NULL,claim_token=NULL,locked_by=NULL,lease_expires_at=NULL WHERE id=${claim.work.id} AND status='PROCESSING' AND claim_token=${claim.token} AND locked_by=${workerId} AND lease_expires_at>${at.toISOString()}`
              .affectedCount()
              .build(),
          )
        : await tx.execute(
            db.raw
              .sql`UPDATE webhook_outbox SET status='PENDING',next_attempt_at=${next},last_error=${error},claim_token=NULL,locked_by=NULL,lease_expires_at=NULL WHERE id=${claim.work.id} AND status='PROCESSING' AND claim_token=${claim.token} AND locked_by=${workerId} AND lease_expires_at>${at.toISOString()}`
              .affectedCount()
              .build(),
          );
    if (changed.affectedRows === 0) return "webhook_stale_completion";
    await checkpoint?.({
      kind: "before-webhook-completion-commit",
      eventId: claim.work.paymentEventId,
    });
    return error;
  });
}
export async function runWebhookWorker({
  db,
  config,
  workerId,
  signal,
  now = () => new Date(),
  checkpoint,
  diagnostic,
}: {
  db: PaybridgeDatabase;
  config: Config;
  workerId: string;
  signal: AbortSignal;
  now?: () => Date;
  checkpoint?: WebhookCheckpoint;
  diagnostic: (value: {
    code: string;
    workerId: string;
    eventId?: string;
  }) => void;
}) {
  while (!signal.aborted) {
    let eventId: string | undefined;
    try {
      const claim = await claimWork({ db, workerId, config, now });
      if (claim) {
        eventId = claim.work.paymentEventId;
        await checkpoint?.({ kind: "after-webhook-claim", eventId });
        // Commit may wait for a reader; bounded HTTP must still fit in the remaining lease.
        if (Date.parse(claim.expires) - now().getTime() <= config.timeoutMs)
          diagnostic({ code: "webhook_claim_exhausted", workerId, eventId });
        else if (!signal.aborted) {
          const error = await deliver({ claim, config, now });
          await checkpoint?.({ kind: "after-webhook-response", eventId });
          const code = await finish({
            db,
            claim,
            workerId,
            config,
            error,
            now,
            ...(checkpoint ? { checkpoint } : {}),
          });
          if (code) diagnostic({ code, workerId, eventId });
        }
      }
    } catch (cause) {
      diagnostic({
        code:
          cause instanceof Error &&
          "transient" in cause &&
          cause.transient === true
            ? "webhook_storage_unavailable"
            : "webhook_iteration_failed",
        workerId,
        ...(eventId ? { eventId } : {}),
      });
    }
    try {
      await delay(config.pollMs, undefined, { signal });
    } catch (cause) {
      if (!signal.aborted) throw cause;
    }
  }
}
