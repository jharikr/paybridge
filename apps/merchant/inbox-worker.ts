import { safeFailure, type SafeFailure } from "../../contracts/diagnostics.ts";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { type } from "arktype";
import { merchantFixture } from "../../contracts/merchant.ts";
import { webhookEvent } from "../../contracts/webhooks.ts";
import type { MerchantDatabase, MerchantTransaction } from "./database.ts";
import { applyPaymentSnapshot } from "./snapshots.ts";

export function inboxWorkerConfig(args: string[]) {
  const [
    lease = "10000",
    poll = "250",
    retryBase = "1000",
    retryMax = "60000",
  ] = args;
  const config = {
    leaseMs: type("1 <= number.integer <= 300000").assert(Number(lease)),
    pollMs: type("1 <= number.integer <= 60000").assert(Number(poll)),
    retryBaseMs: type("1 <= number.integer <= 300000").assert(
      Number(retryBase),
    ),
    retryMaxMs: type("1 <= number.integer <= 3600000").assert(Number(retryMax)),
  };
  if (config.retryBaseMs > config.retryMaxMs)
    throw new Error("Inbox retry delay must not exceed its cap");
  return config;
}
type Config = ReturnType<typeof inboxWorkerConfig>;
export type InboxCheckpoint = (event: {
  kind:
    | "after-inbox-claim"
    | "before-inbox-completion-commit"
    | "after-inbox-completion";
  eventId: string;
}) => Promise<void>;

async function claimWork({
  db,
  workerId,
  config,
  now,
}: {
  db: MerchantDatabase;
  workerId: string;
  config: Config;
  now: () => Date;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(
      db.raw.sql`UPDATE webhook_inbox SET attempt_count=attempt_count WHERE 0`
        .affectedCount()
        .build(),
    );
    const at = now();
    const expires = new Date(at.getTime() + config.leaseMs).toISOString();
    const token = randomUUID();
    const changed = await tx.execute(
      db.raw.sql`
      UPDATE webhook_inbox SET status='PROCESSING',claim_token=${token},locked_by=${workerId},lease_expires_at=${expires},attempt_count=attempt_count+1
      WHERE event_id=(SELECT event_id FROM webhook_inbox WHERE (status='PENDING' AND next_attempt_at<=${at.toISOString()}) OR (status='PROCESSING' AND lease_expires_at<=${at.toISOString()}) ORDER BY next_attempt_at,event_id LIMIT 1)
    `
        .affectedCount()
        .build(),
    );
    if (changed.affectedRows === 0) return null;
    const work = await tx.orm.WebhookInbox.where({ claimToken: token }).first();
    if (!work) throw new Error("Claimed inbox receipt is missing");
    return { ...work, claimToken: token };
  });
}
type Claim = NonNullable<Awaited<ReturnType<typeof claimWork>>>;

async function lockClaim({
  db,
  tx,
  claim,
  workerId,
  now,
}: {
  db: MerchantDatabase;
  tx: MerchantTransaction;
  claim: Claim;
  workerId: string;
  now: () => Date;
}) {
  await tx.execute(
    db.raw.sql`UPDATE webhook_inbox SET attempt_count=attempt_count WHERE 0`
      .affectedCount()
      .build(),
  );
  const at = now().toISOString();
  const owned = await tx.execute(
    db.raw.sql`
    UPDATE webhook_inbox SET attempt_count=attempt_count
    WHERE event_id=${claim.eventId} AND status='PROCESSING' AND claim_token=${claim.claimToken} AND locked_by=${workerId} AND lease_expires_at>${at}
  `
      .affectedCount()
      .build(),
  );
  return owned.affectedRows === 1 ? at : null;
}

async function reschedule({
  db,
  tx,
  claim,
  config,
  at,
  code,
}: {
  db: MerchantDatabase;
  tx: MerchantTransaction;
  claim: Claim;
  config: Config;
  at: string;
  code: string;
}) {
  const backoff = Math.min(
    config.retryMaxMs,
    config.retryBaseMs * 2 ** Math.min(claim.attemptCount - 1, 30),
  );
  const next = new Date(Date.parse(at) + backoff).toISOString();
  await tx.execute(
    db.raw.sql`
    UPDATE webhook_inbox SET status='PENDING',next_attempt_at=${next},last_error=${code},claim_token=NULL,locked_by=NULL,lease_expires_at=NULL
    WHERE event_id=${claim.eventId}
  `
      .affectedCount()
      .build(),
  );
}

async function processClaim({
  db,
  claim,
  workerId,
  config,
  now,
  checkpoint,
}: {
  db: MerchantDatabase;
  claim: Claim;
  workerId: string;
  config: Config;
  now: () => Date;
  checkpoint?: InboxCheckpoint;
}) {
  return db.transaction(async (tx) => {
    const at = await lockClaim({ db, tx, claim, workerId, now });
    if (at === null) return "inbox_claim_lost";
    const event = webhookEvent.assert(JSON.parse(claim.payload));
    const applied = await applyPaymentSnapshot({
      db,
      tx,
      receivingMerchantId: merchantFixture.assert(claim.receivingMerchantId),
      snapshot: event.data,
    });
    if (applied.kind === "unmatched" || applied.kind === "conflict") {
      const code = `inbox_binding_${applied.kind}`;
      await reschedule({ db, tx, claim, config, at, code });
      return code;
    }
    await tx.execute(
      db.raw.sql`
      UPDATE webhook_inbox SET status='PROCESSED',processed_at=${at},claim_token=NULL,locked_by=NULL,lease_expires_at=NULL
      WHERE event_id=${claim.eventId}
    `
        .affectedCount()
        .build(),
    );
    await checkpoint?.({
      kind: "before-inbox-completion-commit",
      eventId: claim.eventId,
    });
    return null;
  });
}

export async function runInboxWorker({
  db,
  config,
  workerId,
  signal,
  now = () => new Date(),
  checkpoint,
  diagnostic,
}: {
  db: MerchantDatabase;
  config: Config;
  workerId: string;
  signal: AbortSignal;
  now?: () => Date;
  checkpoint?: InboxCheckpoint;
  diagnostic: (value: {
    code: string;
    failure?: SafeFailure;
    workerId: string;
    eventId?: string;
  }) => void;
}) {
  while (!signal.aborted) {
    let operation: SafeFailure["operation"] = "inbox_claim";
    let eventId: string | undefined;
    try {
      const claim = await claimWork({ db, workerId, config, now });
      if (claim && !signal.aborted) {
        eventId = claim.eventId;
        await checkpoint?.({ kind: "after-inbox-claim", eventId });
        let code: string | null;
        let failure: SafeFailure | undefined;
        try {
          operation = "inbox_application";
          code = await processClaim({
            db,
            claim,
            workerId,
            config,
            now,
            ...(checkpoint ? { checkpoint } : {}),
          });
        } catch (cause) {
          failure = safeFailure({ operation, cause });
          operation = "inbox_retry";
          code = await db.transaction(async (tx) => {
            const at = await lockClaim({ db, tx, claim, workerId, now });
            if (at === null) return "inbox_claim_lost";
            await reschedule({
              db,
              tx,
              claim,
              config,
              at,
              code: "inbox_application_failed",
            });
            return "inbox_application_failed";
          });
        }
        await checkpoint?.({ kind: "after-inbox-completion", eventId });
        if (code)
          diagnostic({
            code,
            workerId,
            eventId,
            ...(failure ? { failure } : {}),
          });
      }
    } catch (cause) {
      diagnostic({
        failure: safeFailure({ operation, cause }),
        code:
          cause instanceof Error &&
          "transient" in cause &&
          cause.transient === true
            ? "inbox_storage_unavailable"
            : "inbox_iteration_failed",
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
