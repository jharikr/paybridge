import { randomUUID } from "node:crypto";
import type { ReconciliationCommand } from "../../contracts/reconciliation.ts";
import type { PaybridgeDatabase } from "./database.ts";
import { appendFinancialEvent } from "./financial-events.ts";

export class ReconciliationError extends Error {
  readonly code:
    | "invalid_command"
    | "reconciliation_not_found"
    | "reconciliation_conflict"
    | "evidence_mismatch";
  constructor(code: ReconciliationError["code"]) {
    super(code);
    this.code = code;
  }
}

export async function reconcile({
  db,
  command,
  beforeCommit,
}: {
  db: PaybridgeDatabase;
  command: ReconciliationCommand;
  beforeCommit?: () => Promise<void>;
}) {
  if (command.kind === "list") {
    const cases = await db.orm.Reconciliation.where((item) =>
      item.status.in(["REQUIRED", "IN_PROGRESS"]),
    )
      .include("attempt")
      .include("payment")
      .orderBy((item) => item.createdAt.asc())
      .all();
    return {
      kind: "listed",
      cases: cases.map(({ attempt, payment, ...item }) => ({
        ...item,
        providerAccount: attempt.providerAccountRef,
        tranId: attempt.providerTransactionId,
        invoice: payment.providerInvoice,
        amountMinor: payment.amount,
        currency: payment.currency,
      })),
    };
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      db.raw.sql`UPDATE reconciliations SET id = id WHERE 0`
        .affectedCount()
        .build(),
    );
    const record = await tx.orm.Reconciliation.where({
      id: command.reconciliationId,
    }).first();
    if (!record) throw new ReconciliationError("reconciliation_not_found");
    const evidence =
      command.kind === "resolve"
        ? JSON.stringify(canonicalEvidence(command.evidence.evidence))
        : "";
    if (record.status === "RESOLVED") {
      if (
        command.kind === "resolve" &&
        record.resolution === command.resolution &&
        record.resolvedBy === command.operator &&
        record.reason === command.reason &&
        record.notes === (command.notes ?? null) &&
        record.evidenceReference === command.evidenceReference &&
        record.evidence === evidence
      )
        return {
          kind: "resolved",
          case: {
            ...record,
            evidence: canonicalEvidence(command.evidence.evidence),
          },
        };
      throw new ReconciliationError("reconciliation_conflict");
    }
    if (command.kind === "start" && record.status === "IN_PROGRESS")
      return { kind: "started", case: record };
    const payment = await tx.orm.PaymentIntent.where({
      id: record.paymentIntentId,
    }).first();
    const attempt = await tx.orm.PaymentAttempt.where({
      id: record.paymentAttemptId,
    }).first();
    if (
      !payment ||
      !attempt ||
      payment.status !== "UNKNOWN" ||
      attempt.status !== "UNKNOWN"
    )
      throw new ReconciliationError("reconciliation_conflict");
    const at = new Date().toISOString();
    if (command.kind === "resolve") {
      const facts = command.evidence.evidence;
      const outcome =
        facts.finalOutcome === "Approved" ? "SUCCEEDED" : "FAILED";
      if (
        facts.providerAccount !== attempt.providerAccountRef ||
        facts.tranId !== attempt.providerTransactionId ||
        facts.invoice !== payment.providerInvoice ||
        facts.amountMinor !== payment.amount ||
        facts.currency !== payment.currency ||
        command.resolution !== outcome
      )
        throw new ReconciliationError("evidence_mismatch");
      const failureCode = outcome === "SUCCEEDED" ? "" : facts.finalOutcome;
      await tx.execute(
        db.raw
          .sql`UPDATE payment_attempts SET status = ${outcome}, failure_code = NULLIF(${failureCode}, ''), provider_financial_result = ${facts.finalOutcome}, provider_host_reference = ${facts.hostReference}, updated_at = ${at} WHERE id = ${attempt.id}`
          .affectedCount()
          .build(),
      );
      await tx.execute(
        db.raw
          .sql`UPDATE payment_intents SET status = ${outcome}, revision = revision + 1, updated_at = ${at} WHERE id = ${payment.id}`
          .affectedCount()
          .build(),
      );
      await tx.execute(
        db.raw
          .sql`UPDATE reconciliations SET status = 'RESOLVED', resolution = ${outcome}, reason = ${command.reason}, notes = NULLIF(${command.notes ?? ""}, ''), evidence_reference = ${command.evidenceReference}, evidence = ${evidence}, resolved_by = ${command.operator}, resolved_at = ${at} WHERE id = ${record.id}`
          .affectedCount()
          .build(),
      );
      await tx.orm.PaymentEvent.create({
        id: `evt_${randomUUID().replaceAll("-", "")}`,
        paymentIntentId: payment.id,
        paymentAttemptId: attempt.id,
        type: "RECONCILIATION_RESOLVED",
        fromStatus: null,
        toStatus: null,
        intentRevision: payment.revision + 1,
        actorType: "OPERATOR",
        actorId: command.operator,
        metadata: JSON.stringify({
          reconciliationId: record.id,
          priorReason: record.reason,
          resolution: outcome,
          reason: command.reason,
          notes: command.notes ?? null,
          evidenceReference: command.evidenceReference,
          evidence: canonicalEvidence(facts),
        }),
        createdAt: at,
      });
      await appendFinancialEvent({
        tx,
        payment: { ...payment, revision: payment.revision + 1 },
        paymentAttemptId: attempt.id,
        fromStatus: "UNKNOWN",
        status: outcome,
        actorType: "OPERATOR",
        actorId: command.operator,
        metadata: JSON.stringify({ reconciliationId: record.id }),
        at,
      });
      await beforeCommit?.();
      return {
        kind: "resolved",
        case: {
          ...record,
          status: "RESOLVED",
          resolution: outcome,
          reason: command.reason,
          notes: command.notes ?? null,
          evidenceReference: command.evidenceReference,
          evidence: canonicalEvidence(facts),
          resolvedBy: command.operator,
          resolvedAt: at,
        },
      };
    }
    await tx.execute(
      db.raw
        .sql`UPDATE reconciliations SET status = 'IN_PROGRESS', started_by = ${command.operator}, started_at = ${at} WHERE id = ${record.id}`
        .affectedCount()
        .build(),
    );
    await tx.orm.PaymentEvent.create({
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      paymentIntentId: payment.id,
      paymentAttemptId: attempt.id,
      type: "RECONCILIATION_STARTED",
      fromStatus: null,
      toStatus: null,
      intentRevision: payment.revision,
      actorType: "OPERATOR",
      actorId: command.operator,
      metadata: JSON.stringify({ reconciliationId: record.id }),
      createdAt: at,
    });
    await beforeCommit?.();
    return {
      kind: "started",
      case: {
        ...record,
        status: "IN_PROGRESS",
        startedBy: command.operator,
        startedAt: at,
      },
    };
  });
}

function canonicalEvidence(
  facts: Extract<
    ReconciliationCommand,
    { kind: "resolve" }
  >["evidence"]["evidence"],
) {
  return {
    providerAccount: facts.providerAccount,
    tranId: facts.tranId,
    invoice: facts.invoice,
    amountMinor: facts.amountMinor,
    currency: facts.currency,
    finalOutcome: facts.finalOutcome,
    effectCount: facts.effectCount,
    hostReference: facts.hostReference,
    approvalCode: facts.approvalCode,
    acceptedAt: facts.acceptedAt,
    requestFingerprint: facts.requestFingerprint,
  };
}
