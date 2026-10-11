import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MIMEType } from "node:util";
import { type } from "arktype";
import {
  buildFourcsRequest,
  mockPaymentMethodRef,
  soapAction,
  soapBodyLimit,
  soapPath,
} from "../../contracts/fourcs.ts";
import type { PaybridgeDatabase } from "./database.ts";
import {
  interpretProviderResponse,
  type ProviderResult,
} from "./provider-result.ts";
import { appendFinancialEvent } from "./financial-events.ts";
import { providerAccounts } from "./provider-accounts.ts";

export function providerWorkerConfig(args: string[]) {
  const [
    path = ".data/paybridge.db",
    origin = "http://127.0.0.1:3102",
    timeout = "3000",
    lease = "10000",
    poll = "250",
  ] = args;
  const url = URL.parse(origin);
  if (
    !url ||
    url.origin !== origin ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("The provider origin must be a local loopback HTTP origin");
  const timeoutMs = type("1 <= number.integer <= 60000").assert(
    Number(timeout),
  );
  const leaseMs = type("1 <= number.integer <= 300000").assert(Number(lease));
  const pollMs = type("1 <= number.integer <= 60000").assert(Number(poll));
  if (timeoutMs >= leaseMs)
    throw new Error(
      "The provider timeout must be shorter than its claim lease",
    );
  return {
    path: type("string > 0").assert(path),
    endpoint: `${origin}${soapPath}`,
    timeoutMs,
    leaseMs,
    pollMs,
  };
}
type WorkerConfig = ReturnType<typeof providerWorkerConfig>;

async function claimWork({
  db,
  workerId,
  leaseMs,
  now,
}: {
  db: PaybridgeDatabase;
  workerId: string;
  leaseMs: number;
  now: () => Date;
}) {
  return db.transaction(async (tx) => {
    // Take write access before starting the lease clock.
    await tx.execute(
      db.raw.sql`UPDATE provider_outbox SET id = id WHERE 0`
        .affectedCount()
        .build(),
    );
    const token = randomUUID();
    const claimedAt = now();
    const at = claimedAt.toISOString();
    const expires = new Date(claimedAt.getTime() + leaseMs).toISOString();
    const changed = await tx.execute(
      db.raw.sql`
      UPDATE provider_outbox SET status = 'PROCESSING', claim_token = ${token}, locked_by = ${workerId}, lease_expires_at = ${expires}, attempt_count = attempt_count + 1, updated_at = ${at}
      WHERE id = (SELECT w.id FROM provider_outbox w JOIN payment_attempts a ON a.id = w.payment_attempt_id JOIN payment_intents p ON p.id = a.payment_intent_id
        WHERE ((w.status = 'PENDING' AND w.next_attempt_at <= ${at}) OR (w.status = 'PROCESSING' AND w.lease_expires_at <= ${at}))
          AND a.status = 'PROCESSING' AND p.status = 'PROCESSING' ORDER BY w.next_attempt_at, w.id LIMIT 1)
    `
        .affectedCount()
        .build(),
    );
    if (changed.affectedRows === 0) return null;
    const work = await tx.orm.ProviderOutbox.where({
      claimToken: token,
    }).first();
    if (!work) throw new Error("Claimed provider work is missing");
    const attempt = await tx.orm.PaymentAttempt.where({
      id: work.paymentAttemptId,
    }).first();
    if (!attempt) throw new Error("Claimed payment attempt is missing");
    const payment = await tx.orm.PaymentIntent.where({
      id: attempt.paymentIntentId,
    }).first();
    if (!payment) throw new Error("Claimed payment is missing");
    return { work, attempt, payment, token, expires };
  });
}
type Claim = NonNullable<Awaited<ReturnType<typeof claimWork>>>;
type Submission =
  | { kind: "response"; result: ProviderResult; observedAt: string }
  | {
      kind: "transport_failure";
      result: Extract<ProviderResult, { kind: "unknown" }> & {
        code: "Timeout" | "TransportFailure";
        evidence: null;
      };
    };

function receivedResponse(result: ProviderResult): Submission {
  return { kind: "response", result, observedAt: new Date().toISOString() };
}

function isSoapMediaType(value: string | null) {
  if (value === null) return false;
  try {
    // MIMEType otherwise discards a charset parameter with whitespace before '='.
    const normalized = value.replace(/(;[ \t]*charset)[ \t]*=[ \t]*/gi, "$1=");
    const mediaType = new MIMEType(normalized);
    return (
      mediaType.essence === "text/xml" &&
      (mediaType.params.get("charset") ?? "utf-8").toLowerCase() === "utf-8"
    );
  } catch {
    return false;
  }
}

async function submit({
  claim,
  config,
}: {
  claim: Claim;
  config: WorkerConfig;
}): Promise<Submission> {
  const account = type("'mock-account-a' | 'mock-account-b'").assert(
    claim.attempt.providerAccountRef,
  );
  const input = {
    merchantKey: providerAccounts[account].merchantKey,
    tranId: claim.attempt.providerTransactionId,
    invoice: claim.payment.providerInvoice,
    amountMinor: claim.payment.amount,
    currency: type("'XCD'").assert(claim.payment.currency),
    mockPaymentMethodRef: mockPaymentMethodRef.assert(
      claim.attempt.mockPaymentMethodRef,
    ),
  };
  const deadline = AbortSignal.timeout(config.timeoutMs);
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      redirect: "error",
      signal: deadline,
      headers: {
        "content-type": "text/xml; charset=utf-8",
        soapaction: soapAction,
      },
      body: buildFourcsRequest(input),
    });
    if (
      response.status !== 200 ||
      !isSoapMediaType(response.headers.get("content-type")) ||
      !response.body
    ) {
      await response.body?.cancel();
      return receivedResponse({
        kind: "unknown",
        code: "InvalidHttpResponse",
        evidence: null,
      });
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > soapBodyLimit)
          return receivedResponse({
            kind: "unknown",
            code: "ResponseTooLarge",
            evidence: null,
          });
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    let xml: string;
    try {
      xml = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch {
      return receivedResponse({
        kind: "unknown",
        code: "MalformedResponse",
        evidence: null,
      });
    }
    return receivedResponse(
      interpretProviderResponse({ xml, expected: input }),
    );
  } catch {
    return {
      kind: "transport_failure",
      result: {
        kind: "unknown",
        code: deadline.aborted ? "Timeout" : "TransportFailure",
        evidence: null,
      },
    };
  }
}

async function saveResult({
  db,
  claim,
  submission,
  workerId,
  now,
  beforeCommit,
}: {
  db: PaybridgeDatabase;
  claim: Claim;
  submission: Submission;
  workerId: string;
  now: () => Date;
  beforeCommit?: () => Promise<void>;
}) {
  return db.transaction(async (tx) => {
    // Acquire the write lock before checking lease time; SQLite contention can outlast a lease.
    await tx.execute(
      db.raw.sql`UPDATE provider_outbox SET id = id WHERE id = ${claim.work.id}`
        .affectedCount()
        .build(),
    );
    const at = now().toISOString();
    const { result } = submission;
    const statuses = {
      succeeded: "SUCCEEDED",
      failed: "FAILED",
      unknown: "UNKNOWN",
    } satisfies Record<
      ProviderResult["kind"],
      "SUCCEEDED" | "FAILED" | "UNKNOWN"
    >;
    const status = statuses[result.kind];
    const failureCode = result.kind === "succeeded" ? "" : result.code;
    const changed = await tx.execute(
      db.raw.sql`
      UPDATE provider_outbox SET status = 'COMPLETED', completed_at = ${at}, updated_at = ${at}, claim_token = NULL, locked_by = NULL, lease_expires_at = NULL
      WHERE id = ${claim.work.id} AND status = 'PROCESSING' AND claim_token = ${claim.token} AND locked_by = ${workerId} AND lease_expires_at > ${at}
        AND EXISTS (SELECT 1 FROM payment_attempts a JOIN payment_intents p ON p.id = a.payment_intent_id WHERE a.id = ${claim.attempt.id} AND a.status = 'PROCESSING' AND p.status = 'PROCESSING')
    `
        .affectedCount()
        .build(),
    );
    if (changed.affectedRows === 0) {
      if (submission.kind === "transport_failure")
        return "provider_transport_not_applied";
      const current = await tx.orm.PaymentIntent.where({
        id: claim.payment.id,
      }).first();
      const attempt = await tx.orm.PaymentAttempt.where({
        id: claim.attempt.id,
      }).first();
      if (!current || !attempt)
        throw new Error("Observed payment attempt is missing");
      const contradictory =
        (attempt.status === "SUCCEEDED" && result.kind === "failed") ||
        (attempt.status === "FAILED" && result.kind === "succeeded");
      await tx.orm.PaymentEvent.create({
        id: `evt_${randomUUID().replaceAll("-", "")}`,
        paymentIntentId: claim.payment.id,
        paymentAttemptId: claim.attempt.id,
        type: "PROVIDER_RESPONSE_OBSERVED",
        fromStatus: null,
        toStatus: null,
        intentRevision: current.revision,
        actorType: "WORKER",
        actorId: workerId,
        metadata: JSON.stringify({
          providerAccount: claim.attempt.providerAccountRef,
          providerTransactionId: claim.attempt.providerTransactionId,
          classification: result.kind,
          failureCode: failureCode || null,
          observedAt: submission.observedAt,
          evidence: result.evidence,
          contradictory,
        }),
        createdAt: at,
      });
      return contradictory
        ? "provider_observation_conflicts"
        : "provider_response_observed";
    }
    await tx.execute(
      db.raw
        .sql`UPDATE payment_attempts SET status = ${status}, failure_code = NULLIF(${failureCode}, ''), provider_operation_result = NULLIF(${result.evidence?.operation ?? ""}, ''), provider_service_result = NULLIF(${result.evidence?.service ?? ""}, ''), provider_financial_result = NULLIF(${result.evidence?.financial ?? ""}, ''), provider_host_reference = NULLIF(${result.evidence?.hostReference ?? ""}, ''), updated_at = ${at} WHERE id = ${claim.attempt.id}`
        .affectedCount()
        .build(),
    );
    await tx.execute(
      db.raw
        .sql`UPDATE payment_intents SET status = ${status}, revision = revision + 1, updated_at = ${at} WHERE id = ${claim.payment.id}`
        .affectedCount()
        .build(),
    );
    if (result.kind === "unknown")
      await tx.orm.Reconciliation.create({
        id: `rec_${randomUUID().replaceAll("-", "")}`,
        paymentIntentId: claim.payment.id,
        paymentAttemptId: claim.attempt.id,
        status: "REQUIRED",
        resolution: null,
        reason: result.code,
        notes: null,
        evidenceReference: null,
        evidence: null,
        startedBy: null,
        resolvedBy: null,
        createdAt: at,
        startedAt: null,
        resolvedAt: null,
      });
    await appendFinancialEvent({
      tx,
      payment: { ...claim.payment, revision: claim.payment.revision + 1 },
      paymentAttemptId: claim.attempt.id,
      fromStatus: "PROCESSING",
      status,
      actorType: "WORKER",
      actorId: workerId,
      metadata: JSON.stringify({
        evidence: result.evidence,
        failureCode: failureCode || null,
      }),
      at,
    });
    await beforeCommit?.();
    return null;
  });
}

export async function runProviderWorker({
  db,
  config,
  workerId,
  signal,
  now = () => new Date(),
  afterClaim,
  beforeResultCommit,
  diagnostic,
}: {
  db: PaybridgeDatabase;
  config: WorkerConfig;
  workerId: string;
  signal: AbortSignal;
  now?: () => Date;
  afterClaim?: () => Promise<void>;
  beforeResultCommit?: () => Promise<void>;
  diagnostic: (value: {
    code: string;
    workerId: string;
    paymentAttemptId?: string;
  }) => void;
}) {
  while (!signal.aborted) {
    let paymentAttemptId: string | undefined;
    try {
      const claim = await claimWork({
        db,
        workerId,
        leaseMs: config.leaseMs,
        now,
      });
      if (claim) {
        paymentAttemptId = claim.attempt.id;
        await afterClaim?.();
        if (Date.parse(claim.expires) - now().getTime() <= config.timeoutMs) {
          diagnostic({
            code: "provider_claim_exhausted",
            workerId,
            paymentAttemptId,
          });
        } else {
          const submission = await submit({ claim, config });
          const code = await saveResult({
            db,
            claim,
            submission,
            workerId,
            now,
            ...(beforeResultCommit ? { beforeCommit: beforeResultCommit } : {}),
          });
          if (code)
            diagnostic({ code, workerId, paymentAttemptId: claim.attempt.id });
        }
      }
    } catch (cause) {
      const code =
        cause instanceof Error &&
        "transient" in cause &&
        cause.transient === true
          ? "provider_worker_storage_unavailable"
          : "provider_worker_iteration_failed";
      diagnostic({
        code,
        workerId,
        ...(paymentAttemptId ? { paymentAttemptId } : {}),
      });
    }
    try {
      await delay(config.pollMs, undefined, { signal });
    } catch (cause) {
      if (!signal.aborted) throw cause;
    }
  }
}
