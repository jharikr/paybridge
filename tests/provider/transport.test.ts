import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { type } from "arktype";
import { expect, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import {
  confirm,
  create,
  expireClaim,
  journey,
  lookup,
  rows,
  workerEntry,
} from "./support.ts";

test.each([
  'text/xml; charset="utf-8"',
  'Text/XML; Charset="UTF-8"',
  'text/xml; charset = "utf-8"',
])(
  "equivalent SOAP media type %s accepts the unchanged provider approval",
  async (contentType) => {
    await using files = await isolatedDatabases();
    await using app = await journey(files);
    await using proxy = await providerProxy({
      upstream: app.mockUrl,
      reply: ({ xml, response }) => {
        response.setHeader("content-type", contentType);
        response.end(xml);
      },
    });
    const { id } = type({ id: "string" }).assert(
      await (await create({ url: app.url })).json(),
    );
    expect((await confirm({ url: app.url, id })).status).toBe(202);
    await app.startWorker({ origin: proxy.origin });
    await expect
      .poll(() => lookup({ url: app.url, id }))
      .toMatchObject({ status: "SUCCEEDED", revision: 3 });
    expect(
      rows({ path: files.paybridge, sql: "SELECT id FROM reconciliations" }),
    ).toEqual([]);
    expect(
      rows({
        path: files.mockFourcs,
        sql: "SELECT effect_count FROM mock_transactions",
      }),
    ).toEqual([{ effect_count: 1 }]);
  },
);

test.each([
  {
    name: "lost connection",
    reply: ({ response }: { xml: string; response: ServerResponse }) =>
      response.destroy(),
  },
  {
    name: "aborted partial body",
    reply: ({ xml, response }: { xml: string; response: ServerResponse }) =>
      response.write(xml.slice(0, 100)),
  },
])(
  "a late $name does not invent a received response observation",
  async ({ reply }) => {
    await using files = await isolatedDatabases();
    await using app = await journey(files);
    await using proxy = await providerProxy({ upstream: app.mockUrl, reply });
    const { id } = type({ id: "string" }).assert(
      await (await create({ url: app.url })).json(),
    );
    expect(
      (
        await confirm({
          url: app.url,
          id,
          options: { fixture: "pm_mock_delayed_response" },
        })
      ).status,
    ).toBe(202);
    const worker = await app.startWorker({
      entrypoint: fileURLToPath(
        new URL("./fixtures/expired-worker.ts", import.meta.url),
      ),
      origin: proxy.origin,
      timeout: 500,
      lease: 1500,
    });
    const gate = type({ kind: "'after-acceptance'", gateId: "string" }).assert(
      await app.mock.message(),
    );
    await expireClaim({ worker, path: files.paybridge });
    app.mock.child.send({ kind: "release", gateId: gate.gateId });
    expect(await worker.message()).toMatchObject({
      code: "provider_transport_not_applied",
    });
    expect(await lookup({ url: app.url, id })).toMatchObject({
      status: "PROCESSING",
      revision: 2,
    });
    expect(
      rows({
        path: files.paybridge,
        sql: "SELECT type FROM payment_events ORDER BY intent_revision",
      }),
    ).toEqual([{ type: "PAYMENT_CREATED" }, { type: "ATTEMPT_CREATED" }]);
    expect(
      rows({ path: files.paybridge, sql: "SELECT id FROM webhook_outbox" }),
    ).toEqual([]);
    expect(
      rows({ path: files.paybridge, sql: "SELECT id FROM reconciliations" }),
    ).toEqual([]);
    expect(
      rows({
        path: files.mockFourcs,
        sql: "SELECT effect_count FROM mock_transactions",
      }),
    ).toEqual([{ effect_count: 1 }]);
  },
);

test.each([
  {
    name: "malformed XML",
    code: "MalformedResponse",
    reply: ({ response }: { xml: string; response: ServerResponse }) =>
      response.end("<invalid"),
  },
  {
    name: "oversized body",
    code: "ResponseTooLarge",
    reply: ({ response }: { xml: string; response: ServerResponse }) =>
      response.end(" ".repeat(18000)),
  },
  {
    name: "invalid HTTP status",
    code: "InvalidHttpResponse",
    reply: ({ xml, response }: { xml: string; response: ServerResponse }) => {
      response.statusCode = 500;
      response.end(xml);
    },
  },
])(
  "a received late $name response retains its classification without financial changes",
  async ({ code, reply }) => {
    await using files = await isolatedDatabases();
    await using app = await journey(files);
    await using proxy = await providerProxy({ upstream: app.mockUrl, reply });
    const { id } = type({ id: "string" }).assert(
      await (await create({ url: app.url })).json(),
    );
    const { paymentAttemptId } = type({ paymentAttemptId: "string" }).assert(
      await (
        await confirm({
          url: app.url,
          id,
          options: { fixture: "pm_mock_delayed_response" },
        })
      ).json(),
    );
    const worker = await app.startWorker({
      entrypoint: fileURLToPath(
        new URL("./fixtures/expired-worker.ts", import.meta.url),
      ),
      origin: proxy.origin,
      timeout: 3000,
      lease: 5000,
    });
    const gate = type({ kind: "'after-acceptance'", gateId: "string" }).assert(
      await app.mock.message(),
    );
    await expireClaim({ worker, path: files.paybridge });
    app.mock.child.send({ kind: "release", gateId: gate.gateId });
    await expect
      .poll(() =>
        rows({
          path: files.paybridge,
          sql: "SELECT type FROM payment_events WHERE type = 'PROVIDER_RESPONSE_OBSERVED'",
        }),
      )
      .toEqual([{ type: "PROVIDER_RESPONSE_OBSERVED" }]);
    expect(await worker.message()).toMatchObject({
      code: "provider_response_observed",
      paymentAttemptId,
    });
    expect(await lookup({ url: app.url, id })).toMatchObject({
      status: "PROCESSING",
      revision: 2,
    });
    const event = type({
      metadata: "string",
      payment_attempt_id: "string",
      intent_revision: "number",
      from_status: "null",
      to_status: "null",
    }).assert(
      rows({
        path: files.paybridge,
        sql: "SELECT metadata, payment_attempt_id, intent_revision, from_status, to_status FROM payment_events WHERE type = 'PROVIDER_RESPONSE_OBSERVED'",
      })[0],
    );
    expect(event).toMatchObject({
      payment_attempt_id: paymentAttemptId,
      intent_revision: 2,
      from_status: null,
      to_status: null,
    });
    expect(JSON.parse(event.metadata)).toMatchObject({
      classification: "unknown",
      failureCode: code,
      evidence: null,
      providerAccount: "mock-account-a",
      providerTransactionId: expect.stringMatching(/^[a-f0-9]{16}$/),
      observedAt: expect.any(String),
    });
    expect(
      rows({ path: files.paybridge, sql: "SELECT id FROM webhook_outbox" }),
    ).toEqual([]);
    expect(
      rows({ path: files.paybridge, sql: "SELECT id FROM reconciliations" }),
    ).toEqual([]);
    expect(
      rows({
        path: files.mockFourcs,
        sql: "SELECT effect_count FROM mock_transactions",
      }),
    ).toEqual([{ effect_count: 1 }]);
  },
);

async function providerProxy({
  upstream,
  reply,
}: {
  upstream: string;
  reply: ({ xml, response }: { xml: string; response: ServerResponse }) => void;
}) {
  const requests: {
    url: string | undefined;
    action: string | string[] | undefined;
    contentType: string | undefined;
    body: string;
  }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      requests.push({
        url: request.url,
        action: request.headers["soapaction"],
        contentType: request.headers["content-type"],
        body,
      });
      const upstreamResponse = await fetch(`${upstream}${request.url}`, {
        method: "POST",
        headers: {
          "content-type": "text/xml; charset=utf-8",
          soapaction:
            '"http://equament.com/Schemas/Fmx/ssis/SSISProcessTransaction"',
        },
        body,
      });
      response.setHeader("content-type", "text/xml; charset=utf-8");
      reply({ xml: await upstreamResponse.text(), response });
    })().catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = type({ port: "number" }).assert(server.address());
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("wire requests preserve exact integer amounts and merchant identities while snapshots match OpenAPI", async () => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  await using proxy = await providerProxy({
    upstream: app.mockUrl,
    reply: ({ xml, response }) =>
      response.end(
        xml
          .replace(
            "<ErrorMessage></ErrorMessage>",
            "<ErrorMessage>synthetic-secret &lt;&amp;&gt;</ErrorMessage><ExtraField>synthetic-secret</ExtraField>",
          )
          .replaceAll("soap:", "s:")
          .replace("xmlns:soap", "xmlns:s")
          .replace(
            /<(ApprovalCode|HostReference|BatchId|AVSResult|NetworkResponseCode)>.*?<\/\1>/g,
            "",
          ),
      ),
  });
  await app.startWorker({ origin: proxy.origin });
  const document = type({
    paths: {
      "/v1/payment-intents/{paymentId}": {
        get: {
          responses: {
            "200": { content: { "application/json": { schema: "object" } } },
          },
        },
      },
    },
  }).assert(await (await fetch(`${app.url}/openapi.json`)).json());
  const validates = new Ajv2020({ strict: false }).compile(
    document.paths["/v1/payment-intents/{paymentId}"].get.responses["200"]
      .content["application/json"].schema,
  );
  expect(
    document.paths["/v1/payment-intents/{paymentId}"].get.responses["200"]
      .content["application/json"].schema,
  ).toMatchObject({
    properties: {
      status: {
        description: expect.stringContaining("authorization and posting"),
      },
      latestAttempt: expect.any(Object),
    },
  });
  for (const { amount, expected, merchant } of [
    { amount: 1, expected: "0.01", merchant: "a" },
    { amount: 99, expected: "0.99", merchant: "b" },
    { amount: 100, expected: "1.00", merchant: "a" },
    { amount: 7500, expected: "75.00", merchant: "b" },
    { amount: 9_999_999_999, expected: "99999999.99", merchant: "a" },
  ]) {
    const key = `amount-${amount}`;
    const { id } = type({ id: "string" }).assert(
      await (
        await create({ url: app.url, options: { key, amount, merchant } })
      ).json(),
    );
    expect(
      (
        await confirm({
          url: app.url,
          id,
          options: { key: `confirm-${key}`, merchant },
        })
      ).status,
    ).toBe(202);
    await expect
      .poll(() => lookup({ url: app.url, id, merchant }))
      .toMatchObject({ status: "SUCCEEDED", revision: 3 });
    expect(validates(await lookup({ url: app.url, id, merchant }))).toBe(true);
    const wire = proxy.requests.at(-1);
    expect(wire).toMatchObject({
      url: "/TranSvcs/ssis.asmx",
      action: '"http://equament.com/Schemas/Fmx/ssis/SSISProcessTransaction"',
      contentType: "text/xml; charset=utf-8",
    });
    expect(wire?.body).toContain(`<Amount>${expected}</Amount>`);
    expect(wire?.body).toContain(
      `<MerchantKey>mock-provider-key-${merchant}</MerchantKey>`,
    );
    expect(wire?.body).toMatch(/<TranType>AuthAndPost<\/TranType>/);
    expect(wire?.body).not.toMatch(
      /Order|other|mock-paybridge-key|merchantReference|description/,
    );
    const stored = type({
      provider_transaction_id: "string",
      provider_invoice: "string",
      provider_account_ref: "string",
    }).assert(
      rows({
        path: files.paybridge,
        sql: `SELECT a.provider_transaction_id, a.provider_account_ref, p.provider_invoice FROM payment_attempts a JOIN payment_intents p ON p.id = a.payment_intent_id WHERE p.amount = ${amount}`,
      })[0],
    );
    expect(stored.provider_transaction_id).toMatch(/^[A-Za-z0-9]{1,16}$/);
    expect(stored.provider_invoice).toMatch(/^[A-Za-z0-9]{1,16}$/);
    expect(wire?.body).toContain(
      `<TranId>${stored.provider_transaction_id}</TranId>`,
    );
    expect(wire?.body).toContain(
      `<Invoice>${stored.provider_invoice}</Invoice>`,
    );
    expect(
      rows({
        path: files.mockFourcs,
        sql: `SELECT provider_account, tran_id, invoice, amount_minor, currency FROM mock_transactions WHERE amount_minor = ${amount}`,
      }),
    ).toEqual([
      {
        provider_account: stored.provider_account_ref,
        tran_id: stored.provider_transaction_id,
        invoice: stored.provider_invoice,
        amount_minor: amount,
        currency: "XCD",
      },
    ]);
  }
  expect(
    JSON.stringify(
      rows({
        path: files.paybridge,
        sql: "SELECT metadata FROM payment_events",
      }),
    ),
  ).not.toContain("synthetic-secret");
  expect(
    rows({
      path: files.paybridge,
      sql: "SELECT provider_host_reference FROM payment_attempts",
    }),
  ).toEqual(
    Array.from({ length: 5 }, () => ({ provider_host_reference: null })),
  );
});

const corruptions = [
  {
    name: "DTD",
    transform: (xml: string) =>
      xml.replace(
        "?><soap",
        '?><!DOCTYPE fake [<!ENTITY stolen SYSTEM "file:///etc/passwd">]><soap',
      ),
    code: "MalformedResponse",
  },
  {
    name: "duplicate outcome",
    transform: (xml: string) =>
      xml.replace("<ResultCode>", "<ResultCode>OK</ResultCode><ResultCode>"),
    code: "MalformedResponse",
  },
  {
    name: "duplicate structure",
    transform: (xml: string) =>
      xml.replace(
        "<response>",
        "<SSISProcessTransactionResult>OK</SSISProcessTransactionResult><response>",
      ),
    code: "MalformedResponse",
  },
  {
    name: "nested scalar",
    transform: (xml: string) =>
      xml.replace("<ResultCode>OK", "<ResultCode><OK/>"),
    code: "MalformedResponse",
  },
  {
    name: "wrong namespace",
    transform: (xml: string) =>
      xml.replace("http://equament.com/Schemas/Fmx/ssis", "urn:wrong"),
    code: "MalformedResponse",
  },
  {
    name: "missing echo",
    transform: (xml: string) => xml.replace(/<Invoice>.*?<\/Invoice>/, ""),
    code: "MalformedResponse",
  },
  {
    name: "wrong invoice",
    transform: (xml: string) =>
      xml.replace(/<Invoice>.*?<\/Invoice>/, "<Invoice>WRONG</Invoice>"),
    code: "MismatchedEcho",
  },
  {
    name: "wrong amount",
    transform: (xml: string) => xml.replace("<Amount>75.00", "<Amount>74.99"),
    code: "MismatchedEcho",
  },
  {
    name: "wrong currency",
    transform: (xml: string) => xml.replace("<Currency>XCD", "<Currency>USD"),
    code: "MismatchedEcho",
  },
  {
    name: "unsupported financial result",
    transform: (xml: string) =>
      xml.replace(
        "<FinancialResultCode>Approved",
        "<FinancialResultCode>Unrecognized",
      ),
    code: "InvalidFinancialResult",
  },
  {
    name: "unbounded reference",
    transform: (xml: string) =>
      xml.replace(
        /<HostReference>.*?<\/HostReference>/,
        `<HostReference>${"a".repeat(1024)}</HostReference>`,
      ),
    code: "MalformedResponse",
  },
];
test.each(corruptions)(
  "$name cannot establish a financial result from an approved upstream response",
  async ({ transform, code }) => {
    await using files = await isolatedDatabases();
    await using app = await journey(files);
    await using proxy = await providerProxy({
      upstream: app.mockUrl,
      reply: ({ xml, response }) => response.end(transform(xml)),
    });
    const { id } = type({ id: "string" }).assert(
      await (await create({ url: app.url })).json(),
    );
    expect((await confirm({ url: app.url, id })).status).toBe(202);
    const worker = await app.startWorker({ origin: proxy.origin });
    await expect
      .poll(() => lookup({ url: app.url, id }))
      .toMatchObject({
        status: "UNKNOWN",
        latestAttempt: { failureCode: code },
      });
    expect(
      rows({
        path: files.mockFourcs,
        sql: "SELECT final_outcome, effect_count FROM mock_transactions",
      }),
    ).toEqual([{ final_outcome: "Approved", effect_count: 1 }]);
    expect(
      rows({
        path: files.paybridge,
        sql: "SELECT status FROM reconciliations",
      }),
    ).toEqual([{ status: "REQUIRED" }]);
    expect(worker.output()).not.toMatch(
      /Envelope|mock-provider-key|file:\/\/|ErrorMessage/,
    );
  },
);

test.each([
  {
    name: "streamed bytes",
    code: "ResponseTooLarge",
    reply: ({ response }: { xml: string; response: ServerResponse }) => {
      response.write(" ".repeat(9000));
      response.end(" ".repeat(9000));
    },
  },
  {
    name: "unfinished response body",
    code: "Timeout",
    reply: ({ xml, response }: { xml: string; response: ServerResponse }) => {
      response.write(xml.slice(0, 100));
    },
  },
  {
    name: "HTTP error",
    code: "InvalidHttpResponse",
    reply: ({ xml, response }: { xml: string; response: ServerResponse }) => {
      response.statusCode = 500;
      response.end(xml);
    },
  },
  {
    name: "wrong media type",
    code: "InvalidHttpResponse",
    reply: ({ xml, response }: { xml: string; response: ServerResponse }) => {
      response.setHeader("content-type", "text/plain");
      response.end(xml);
    },
  },
  {
    name: "unsupported quoted charset",
    code: "InvalidHttpResponse",
    reply: ({ xml, response }: { xml: string; response: ServerResponse }) => {
      response.setHeader("content-type", 'text/xml; charset="iso-8859-1"');
      response.end(xml);
    },
  },
  {
    name: "unsupported spaced charset",
    code: "InvalidHttpResponse",
    reply: ({ xml, response }: { xml: string; response: ServerResponse }) => {
      response.setHeader("content-type", 'text/xml; charset = "iso-8859-1"');
      response.end(xml);
    },
  },
  {
    name: "invalid UTF-8",
    code: "MalformedResponse",
    reply: ({ response }: { xml: string; response: ServerResponse }) =>
      response.end(Buffer.from([0xc0, 0x80])),
  },
  {
    name: "redirect",
    code: "TransportFailure",
    reply: ({ response }: { xml: string; response: ServerResponse }) => {
      response.writeHead(307, { location: "https://example.com/live" });
      response.end();
    },
  },
])("$name is bounded and creates one unknown case", async ({ code, reply }) => {
  await using files = await isolatedDatabases();
  await using app = await journey(files);
  await using proxy = await providerProxy({ upstream: app.mockUrl, reply });
  const { id } = type({ id: "string" }).assert(
    await (await create({ url: app.url })).json(),
  );
  expect((await confirm({ url: app.url, id })).status).toBe(202);
  await app.startWorker({ origin: proxy.origin });
  await expect
    .poll(() => lookup({ url: app.url, id }), { timeout: 2000 })
    .toMatchObject({ status: "UNKNOWN", latestAttempt: { failureCode: code } });
  expect(
    rows({
      path: files.paybridge,
      sql: "SELECT status, reason FROM reconciliations",
    }),
  ).toEqual([{ status: "REQUIRED", reason: code }]);
});

test.each([
  ["https://example.com", "100", "1000"],
  ["http://example.com", "100", "1000"],
  ["http://127.0.0.1:3102/path", "100", "1000"],
  ["http://127.0.0.1:3102", "1000", "1000"],
])(
  "worker rejects nonlocal or invalid timing configuration %s %s %s",
  async (origin, timeout, lease) => {
    await using files = await isolatedDatabases();
    const worker = startNodeProcess({
      entrypoint: workerEntry,
      args: [files.paybridge, origin, timeout, lease],
    });
    try {
      await expect(worker.message()).rejects.toThrow(
        /local loopback|shorter than its claim lease/,
      );
    } finally {
      await worker.stop();
    }
  },
);
