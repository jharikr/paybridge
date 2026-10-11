import { expect, test } from "vitest";
import { type } from "arktype";
import { isolatedDatabases } from "../support/databases.ts";
import { contractAt, compareResponse } from "../contracts/support.ts";
import {
  create,
  confirm,
  journey,
  ready,
  rows,
  serverEntry,
} from "../provider/support.ts";
import { startNodeProcess } from "../support/process.ts";
import {
  checkoutConfirm,
  controlledPaybridge,
  creation,
  paymentRecords,
} from "./support.ts";

test("checkout and direct HTTP confirmations share one atomic revision guard across processes", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const other = startNodeProcess({
    entrypoint: serverEntry,
    args: [files.paybridge, "0"],
  });
  try {
    const url = ready.assert(await other.message()).url;
    const payment = creation.assert(
      await (await create({ url: services.url })).json(),
    );
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        index % 2
          ? checkoutConfirm({ url, payment, key: `checkout-${index}` })
          : confirm({
              url: services.url,
              id: payment.id,
              options: { key: `direct-${index}` },
            }),
      ),
    );
    expect(
      responses.filter((response) => [202, 303].includes(response.status)),
    ).toHaveLength(1);
    for (const rejected of responses.filter(
      (response) => response.status === 409,
    ))
      expect(await rejected.json()).toMatchObject({
        error: { code: "payment_revision_conflict" },
      });
    expect(
      responses.filter((response) => response.status === 409),
    ).toHaveLength(11);
    expect(
      rows({ path: files.paybridge, sql: "SELECT id FROM payment_attempts" }),
    ).toHaveLength(1);
    expect(
      rows({ path: files.paybridge, sql: "SELECT id FROM provider_outbox" }),
    ).toHaveLength(1);
    const second = creation.assert(
      await (
        await create({ url: services.url, options: { key: "second" } })
      ).json(),
    );
    const repeats = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        checkoutConfirm({
          url: index % 2 ? url : services.url,
          payment: second,
        }),
      ),
    );
    expect(repeats.every((response) => response.status === 303)).toBe(true);
    expect(
      new Set(repeats.map((response) => response.headers.get("location"))).size,
    ).toBe(1);
    expect(
      await Promise.all(repeats.map((response) => response.text())),
    ).toEqual(Array(12).fill(""));
    expect(
      rows({ path: files.paybridge, sql: "SELECT id FROM payment_attempts" }),
    ).toHaveLength(2);
  } finally {
    await other.stop();
  }
});

test("checkout rollback and a killed acceptance transaction retain no partial attempt or command", async () => {
  await using files = await isolatedDatabases();
  const rollback = await controlledPaybridge({
    path: files.paybridge,
    fault: "rollback",
  });
  let payment: typeof creation.infer;
  try {
    payment = creation.assert(
      await (await create({ url: rollback.url })).json(),
    );
    const before = paymentRecords(files.paybridge);
    const failed = await checkoutConfirm({ url: rollback.url, payment });
    expect(failed.status).toBe(500);
    await compareResponse({
      contract: await contractAt(rollback.url),
      path: "/checkout/{paymentId}/confirm",
      method: "post",
      response: failed,
      status: 500,
    });
    expect(paymentRecords(files.paybridge)).toEqual(before);
  } finally {
    await rollback.stop();
  }
  const held = await controlledPaybridge({
    path: files.paybridge,
    fault: "before-commit",
  });
  try {
    const before = paymentRecords(files.paybridge);
    const interrupted = checkoutConfirm({ url: held.url, payment }).then(
      () => "response",
      () => "lost",
    );
    expect(await held.message()).toEqual({ kind: "before-commit" });
    await held.stop();
    expect(await interrupted).toBe("lost");
    expect(paymentRecords(files.paybridge)).toEqual(before);
  } finally {
    await held.stop();
  }
  await using services = await journey(files);
  expect((await checkoutConfirm({ url: services.url, payment })).status).toBe(
    303,
  );
  expect(
    rows({ path: files.paybridge, sql: "SELECT id FROM payment_attempts" }),
  ).toHaveLength(1);
});

test("a lost committed checkout redirect survives process restart with its exact cached acknowledgment", async () => {
  await using files = await isolatedDatabases();
  const original = await controlledPaybridge({
    path: files.paybridge,
    fault: "after-commit",
  });
  let payment: typeof creation.infer;
  let committed: ReturnType<typeof paymentRecords>;
  const acknowledgment = type({
    response_status: "number",
    response_body: "string",
    response_headers: "string",
  });
  let cached: typeof acknowledgment.infer;
  try {
    payment = creation.assert(
      await (await create({ url: original.url })).json(),
    );
    const interrupted = checkoutConfirm({ url: original.url, payment }).then(
      () => "response",
      () => "lost",
    );
    expect(await original.message()).toEqual({ kind: "after-commit" });
    committed = paymentRecords(files.paybridge);
    cached = acknowledgment.assert(
      rows({
        path: files.paybridge,
        sql: "SELECT response_status, response_body, response_headers FROM idempotency_keys WHERE key = 'checkout-1'",
      })[0],
    );
    await original.stop();
    expect(await interrupted).toBe("lost");
  } finally {
    await original.stop();
  }
  await using services = await journey(files);
  const replay = await checkoutConfirm({ url: services.url, payment });
  expect(replay.status).toBe(cached.response_status);
  expect(await replay.text()).toBe(cached.response_body);
  for (const [name, value] of Object.entries(
    type({ "[string]": "string" }).assert(JSON.parse(cached.response_headers)),
  ))
    expect(replay.headers.get(name)).toBe(value);
  expect(paymentRecords(files.paybridge)).toEqual(committed);
});
