import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { type } from "arktype";
import {
  finalEvidence,
  reconciliationId,
  resolutionCommand,
} from "../../contracts/reconciliation.ts";
import { paymentId } from "../../contracts/payments.ts";
import { ownedProcess, requireDemo } from "./process.ts";

const listed = type({
  kind: "'listed'",
  cases: type({
    id: reconciliationId,
    paymentIntentId: paymentId,
    providerAccount: "'mock-account-a' | 'mock-account-b'",
    tranId: "string",
  }).array(),
});

export async function operatorCommands({
  directory,
  files,
}: {
  directory: string;
  files: { paybridge: string; mock: string };
}) {
  const operatorDirectory = join(directory, "operator");
  await mkdir(operatorDirectory, { mode: 0o700 });
  async function command({ name, input }: { name: string; input: unknown }) {
    const path = join(operatorDirectory, `${name}.json`);
    await writeFile(path, JSON.stringify(input, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    const child = ownedProcess({
      entrypoint: fileURLToPath(
        new URL("../../apps/paybridge/reconcile.ts", import.meta.url),
      ),
      args: [files.paybridge, path],
      capture: true,
    });
    try {
      return await child.result();
    } finally {
      await child.stop();
    }
  }
  const result = await command({ name: "list", input: { kind: "list" } });
  requireDemo({
    condition: result.code === 0,
    code: "reconciliation_list_failed",
  });
  const cases = listed.assert(result.value).cases;
  async function resolve({
    id,
    name,
    resolution,
  }: {
    id: string;
    name: string;
    resolution: "SUCCEEDED" | "FAILED" | "ABSENT";
  }) {
    const item = requireDemo({
      condition: cases.find((item) => item.paymentIntentId === id),
      code: "reconciliation_missing",
    });
    const started = await command({
      name: `start-${name}`,
      input: {
        kind: "start",
        reconciliationId: item.id,
        operator: "demo-operator",
      },
    });
    requireDemo({
      condition:
        started.code === 0 && type({ kind: "'started'" }).allows(started.value),
      code: "reconciliation_start_failed",
    });
    const inspector = ownedProcess({
      entrypoint: fileURLToPath(
        new URL("../../apps/mock-fourcs/inspect.ts", import.meta.url),
      ),
      args: [files.mock, item.providerAccount, item.tranId],
      capture: true,
    });
    const inspected = await inspector.result();
    await inspector.stop();
    requireDemo({
      condition: inspected.code === 0,
      code: "ledger_inspection_failed",
    });
    const base = {
      kind: "resolve",
      reconciliationId: item.id,
      operator: "demo-operator",
      resolution: resolution === "ABSENT" ? "FAILED" : resolution,
      reason: "Synthetic operator checked immutable mock ledger evidence.",
      evidenceReference: `demo-ledger:${item.providerAccount}:${item.tranId}`,
    };
    if (resolution === "ABSENT") {
      const absent = type({
        kind: "'absent'",
        providerAccount: "string",
        tranId: "string",
      }).assert(inspected.value);
      const rejected = await command({
        name: "reject-absent",
        input: {
          ...base,
          evidence: absent,
        },
      });
      requireDemo({
        condition:
          rejected.code === 1 &&
          type({ kind: "'error'", code: "'invalid_command'" }).allows(
            rejected.value,
          ),
        code: "absent_evidence_accepted",
      });
      return;
    }
    const recorded = type({
      kind: "'recorded'",
      evidence: finalEvidence,
    }).assert(inspected.value);
    const input = resolutionCommand.assert({ ...base, evidence: recorded });
    const resolved = await command({ name: `resolve-${name}`, input });
    requireDemo({
      condition:
        resolved.code === 0 &&
        type({ kind: "'resolved'" }).allows(resolved.value),
      code: "reconciliation_resolution_failed",
    });
    const replay = await command({ name: `replay-${name}`, input });
    requireDemo({
      condition:
        replay.code === 0 &&
        JSON.stringify(replay.value) === JSON.stringify(resolved.value),
      code: "reconciliation_replay_changed",
    });
    const conflict = await command({
      name: `conflict-${name}`,
      input: {
        ...input,
        reason: "Conflicting replacement is forbidden.",
      },
    });
    requireDemo({
      condition:
        conflict.code === 1 &&
        type({ kind: "'error'", code: "'reconciliation_conflict'" }).allows(
          conflict.value,
        ),
      code: "reconciliation_conflict_accepted",
    });
  }
  return { resolve };
}
