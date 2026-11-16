import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { openProofDatabase, writeProofRecord } from "./proof/database.ts";

test("a committed record survives closing and reopening its SQLite file", async () => {
  await using files = await isolatedDatabases();
  {
    await using db = await openProofDatabase({ path: files.paybridge });
    await db.orm.ProofRecord.create({
      id: "retained",
      label: "Synthetic record",
      amount: 1250,
    });
  }
  await using reopened = await openProofDatabase({ path: files.paybridge });
  expect(
    await reopened.orm.ProofRecord.where({ id: "retained" }).first(),
  ).toEqual({
    id: "retained",
    label: "Synthetic record",
    amount: 1250,
  });
});

test("migrations enforce foreign keys, positive amounts, uniqueness, and one unresolved attempt after reopen", async () => {
  await using files = await isolatedDatabases();
  const initial = await openProofDatabase({ path: files.paybridge });
  await initial.close();
  await using db = await openProofDatabase({ path: files.paybridge });
  expect(
    await db
      .runtime()
      .query(
        db.raw.sql`PRAGMA foreign_keys`
          .returnsRow({ foreign_keys: "sqlite/integer@1" })
          .build(),
      ),
  ).toEqual([{ foreign_keys: 1 }]);
  expect(
    await db
      .runtime()
      .query(
        db.raw.sql`PRAGMA busy_timeout`
          .returnsRow({ timeout: "sqlite/integer@1" })
          .build(),
      ),
  ).toEqual([{ timeout: 5000 }]);
  expect(
    await db
      .runtime()
      .query(
        db.raw.sql`PRAGMA journal_mode`
          .returnsRow({ journal_mode: "sqlite/text@1" })
          .build(),
      ),
  ).toEqual([{ journal_mode: "delete" }]);
  expect(
    await db
      .runtime()
      .query(
        db.raw.sql`PRAGMA synchronous`
          .returnsRow({ synchronous: "sqlite/integer@1" })
          .build(),
      ),
  ).toEqual([{ synchronous: 2 }]);
  await db.orm.ProofRecord.create({
    id: "parent",
    label: "Synthetic parent",
    amount: 1250,
  });
  await expect(
    db.orm.ProofRecord.create({ id: "invalid", label: "Invalid", amount: 0 }),
  ).rejects.toThrow();
  await expect(
    db.orm.ProofRecord.create({
      id: "parent",
      label: "Duplicate",
      amount: 100,
    }),
  ).rejects.toThrow();

  const insertAttempt = ({
    id,
    recordId,
    status,
  }: {
    id: string;
    recordId: string;
    status: string;
  }) =>
    db.runtime().execute(
      db.raw.sql`
      INSERT INTO proof_attempts (id, record_id, status) VALUES (${id}, ${recordId}, ${status})
    `
        .affectedCount()
        .build(),
    );
  await expect(
    insertAttempt({ id: "orphan", recordId: "absent", status: "PROCESSING" }),
  ).rejects.toThrow();
  expect(
    await insertAttempt({
      id: "declined",
      recordId: "parent",
      status: "FAILED",
    }),
  ).toEqual({ affectedRows: 1 });
  expect(
    await insertAttempt({
      id: "active",
      recordId: "parent",
      status: "PROCESSING",
    }),
  ).toEqual({ affectedRows: 1 });
  await expect(
    insertAttempt({ id: "overlap", recordId: "parent", status: "UNKNOWN" }),
  ).rejects.toThrow();
  await expect(
    insertAttempt({ id: "invalid", recordId: "parent", status: "APPROVED" }),
  ).rejects.toThrow();
  expect(
    await db.runtime().execute(
      db.raw.sql`
      UPDATE proof_attempts SET status = ${"FAILED"} WHERE id = ${"active"}
    `
        .affectedCount()
        .build(),
    ),
  ).toEqual({ affectedRows: 1 });
  expect(
    await insertAttempt({
      id: "deliberate",
      recordId: "parent",
      status: "UNKNOWN",
    }),
  ).toEqual({ affectedRows: 1 });
});

test("mixed ORM and bound raw writes commit together and roll back on failure", async () => {
  await using files = await isolatedDatabases();
  await using db = await openProofDatabase({ path: files.paybridge });
  const label = "'); DROP TABLE proof_records; --";
  expect(
    await writeProofRecord({
      db,
      record: { id: "bound", label, amount: 1250 },
    }),
  ).toEqual({ affectedRows: 1 });
  expect(await db.orm.ProofRecord.where({ id: "bound" }).first()).toEqual({
    id: "bound",
    label,
    amount: 1250,
  });

  await expect(
    writeProofRecord({
      db,
      record: { id: "interrupted", label: "Must roll back", amount: 2900 },
      afterWrites: async () => {
        throw new Error("Injected failure");
      },
    }),
  ).rejects.toThrow("Injected failure");
  expect(
    await db.orm.ProofRecord.where({ id: "interrupted" }).first(),
  ).toBeNull();
  expect(
    await db
      .runtime()
      .execute(
        db.raw
          .sql`UPDATE proof_records SET amount = ${20} WHERE id = ${"absent"}`
          .affectedCount()
          .build(),
      ),
  ).toEqual({ affectedRows: 0 });
});
