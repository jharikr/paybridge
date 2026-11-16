import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import { openProofDatabase, writeProofRecord } from "./proof/database.ts";

const entrypoint = fileURLToPath(new URL("./proof/worker.ts", import.meta.url));
const ready = type({ kind: "'ready'" });
const changed = type({ kind: "'changed'", count: "number.integer" });

test("competing processes claim once, reclaim expiry, and reject an obsolete completion token", async () => {
  await using files = await isolatedDatabases();
  const db = await openProofDatabase({ path: files.paybridge });
  await db.orm.ProofWork.create({
    id: "one",
    status: "PENDING",
    claimToken: null,
    leaseUntil: null,
  });
  await db.close();
  const first = startNodeProcess({ entrypoint, args: [files.paybridge] });
  const second = startNodeProcess({ entrypoint, args: [files.paybridge] });
  try {
    ready.assert(await first.message());
    ready.assert(await second.message());
    first.child.send({ kind: "claim", id: "one", token: "first", now: 100 });
    second.child.send({ kind: "claim", id: "one", token: "second", now: 100 });
    const results = await Promise.all([first.message(), second.message()]);
    expect(
      results.map((result) => changed.assert(result).count).sort(),
    ).toEqual([0, 1]);
    first.child.send({
      kind: "claim",
      id: "one",
      token: "premature",
      now: 109,
    });
    expect(await first.message()).toEqual({ kind: "changed", count: 0 });
    second.child.send({
      kind: "claim",
      id: "one",
      token: "reclaimed",
      now: 111,
    });
    expect(await second.message()).toEqual({ kind: "changed", count: 1 });
    for (const token of ["first", "second"]) {
      first.child.send({ kind: "complete", id: "one", token });
      expect(await first.message()).toEqual({ kind: "changed", count: 0 });
    }
    second.child.send({ kind: "complete", id: "one", token: "reclaimed" });
    expect(await second.message()).toEqual({ kind: "changed", count: 1 });
    first.child.send({
      kind: "claim",
      id: "one",
      token: "too-late",
      now: 1000,
    });
    expect(await first.message()).toEqual({ kind: "changed", count: 0 });
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("process death rolls back interrupted mixed writes and releases bounded writer contention", async () => {
  await using files = await isolatedDatabases();
  const db = await openProofDatabase({ path: files.paybridge });
  await writeProofRecord({
    db,
    record: { id: "retained", label: "Retain this", amount: 1250 },
  });
  await db.orm.ProofWork.create({
    id: "one",
    status: "PENDING",
    claimToken: null,
    leaseUntil: null,
  });
  await db.close();
  const holder = startNodeProcess({ entrypoint, args: [files.paybridge] });
  const contender = startNodeProcess({ entrypoint, args: [files.paybridge] });
  try {
    ready.assert(await holder.message());
    ready.assert(await contender.message());
    holder.child.send({ kind: "hold" });
    expect(await holder.message()).toEqual({ kind: "writes-held" });
    const started = performance.now();
    contender.child.send({
      kind: "claim",
      id: "one",
      token: "blocked",
      now: 100,
    });
    expect(await contender.message()).toEqual({ kind: "busy" });
    expect(performance.now() - started).toBeLessThan(7000);
    await holder.stop();
    contender.child.send({
      kind: "claim",
      id: "one",
      token: "released",
      now: 100,
    });
    expect(await contender.message()).toEqual({ kind: "changed", count: 1 });
  } finally {
    await Promise.all([holder.stop(), contender.stop()]);
  }

  const restarted = startNodeProcess({ entrypoint, args: [files.paybridge] });
  try {
    ready.assert(await restarted.message());
    restarted.child.send({ kind: "read", id: "interrupted" });
    expect(await restarted.message()).toEqual({ kind: "record", record: null });
    restarted.child.send({ kind: "read", id: "retained" });
    expect(await restarted.message()).toEqual({
      kind: "record",
      record: { id: "retained", label: "Retain this", amount: 1250 },
    });
  } finally {
    await restarted.stop();
  }
}, 15_000);
