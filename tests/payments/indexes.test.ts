import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { journey, rows } from "../provider/support.ts";

test("fresh payment storage has the approved query indexes without redundant intent or merchant prefixes", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const indexes = (table: string) =>
    rows({
      path: files.paybridge,
      sql: `SELECT il.name, il.partial, group_concat(ii.name, ',') AS columns FROM pragma_index_list('${table}') il JOIN pragma_index_info(il.name) ii GROUP BY il.name`,
    });
  expect(indexes("payment_intents").map((row) => row.columns)).toEqual(
    expect.arrayContaining([
      "merchant_id,merchant_reference",
      "merchant_id,status",
      "created_at",
    ]),
  );
  expect(indexes("payment_events").map((row) => row.columns)).toContain(
    "payment_intent_id,created_at",
  );
  expect(
    indexes("payment_attempts").filter(
      (row) => row.columns === "payment_intent_id",
    ),
  ).toEqual([
    {
      name: "one_unresolved_attempt",
      partial: 1,
      columns: "payment_intent_id",
    },
  ]);
  expect(
    indexes("webhook_outbox").filter((row) => row.columns === "merchant_id"),
  ).toEqual([]);
});
