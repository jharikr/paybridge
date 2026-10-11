import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { buildFourcsRequest } from "../../contracts/fourcs.ts";
import { createMockFourcs } from "../../apps/mock-fourcs/server.ts";

const endpoint = "/TranSvcs/ssis.asmx";
const action = '"http://equament.com/Schemas/Fmx/ssis/SSISProcessTransaction"';
function requestXml({
  tranId = "TXN1",
  card = "9900000000000001",
  key = "mock-provider-key-a",
} = {}) {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><SSISProcessTransaction xmlns="http://equament.com/Schemas/Fmx/ssis"><request><MerchantKey>${key}</MerchantKey><TranType>AuthAndPost</TranType><Amount>75.00</Amount><Currency>XCD</Currency><Invoice>INV1</Invoice><TranId>${tranId}</TranId><CardNumber>${card}</CardNumber><ExpiryMMYY>1230</ExpiryMMYY><VerificationValue>123</VerificationValue><CardholderName>Fixture Payer</CardholderName><Address>Fixture Address</Address></request></SSISProcessTransaction></s:Body></s:Envelope>`;
}
async function submit(url: string, xml: string) {
  const response = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "text/xml; charset=utf-8", soapaction: action },
    body: xml,
  });
  return { status: response.status, xml: await response.text() };
}
function ledger(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT provider_account, tran_id, invoice, amount_minor, currency, final_outcome, effect_count FROM mock_transactions ORDER BY provider_account, tran_id",
      )
      .all();
  } finally {
    db.close();
  }
}

test("approval is recorded before the SOAP reply and duplicates preserve one account-scoped effect", async () => {
  await using files = await isolatedDatabases();
  const app = await createMockFourcs({ databasePath: files.mockFourcs });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const first = await submit(url, requestXml());
    expect(first.status).toBe(200);
    expect(first.xml).toContain(
      "<SSISProcessTransactionResult>OK</SSISProcessTransactionResult>",
    );
    expect(first.xml).toContain("<ResultCode>OK</ResultCode>");
    expect(first.xml).toContain(
      "<FinancialResultCode>Approved</FinancialResultCode>",
    );
    expect(first.xml).toContain("<Amount>75.00</Amount>");
    expect((await submit(url, requestXml())).xml).toContain(
      "<ResultCode>DuplicateTransaction</ResultCode>",
    );
    expect(ledger(files.mockFourcs)).toEqual([
      {
        provider_account: "mock-account-a",
        tran_id: "TXN1",
        invoice: "INV1",
        amount_minor: 7500,
        currency: "XCD",
        final_outcome: "Approved",
        effect_count: 1,
      },
    ]);
  } finally {
    await app.close();
  }
});

test("decline and incomplete are separate immutable final outcomes, isolated by account", async () => {
  await using files = await isolatedDatabases();
  const app = await createMockFourcs({ databasePath: files.mockFourcs });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    expect(
      (await submit(url, requestXml({ card: "9900000000000002" }))).xml,
    ).toContain("<FinancialResultCode>Declined</FinancialResultCode>");
    expect(
      (
        await submit(
          url,
          requestXml({ card: "9900000000000003", key: "mock-provider-key-b" }),
        )
      ).xml,
    ).toContain("<FinancialResultCode>Incomplete</FinancialResultCode>");
    expect((await submit(url, requestXml())).xml).toContain(
      "<ResultCode>DuplicateTransaction</ResultCode>",
    );
    expect(ledger(files.mockFourcs)).toEqual([
      {
        provider_account: "mock-account-a",
        tran_id: "TXN1",
        invoice: "INV1",
        amount_minor: 7500,
        currency: "XCD",
        final_outcome: "Declined",
        effect_count: 0,
      },
      {
        provider_account: "mock-account-b",
        tran_id: "TXN1",
        invoice: "INV1",
        amount_minor: 7500,
        currency: "XCD",
        final_outcome: "Incomplete",
        effect_count: 0,
      },
    ]);
    const inspector = new DatabaseSync(files.mockFourcs);
    try {
      expect(() =>
        inspector.exec(
          "UPDATE mock_transactions SET final_outcome = 'Approved'",
        ),
      ).toThrow(/immutable/i);
      expect(() => inspector.exec("DELETE FROM mock_transactions")).toThrow(
        /immutable/i,
      );
    } finally {
      inspector.close();
    }
  } finally {
    await app.close();
  }
});

test("ambiguous response fixtures retain accepted facts while keeping all three result layers distinct", async () => {
  await using files = await isolatedDatabases();
  const app = await createMockFourcs({ databasePath: files.mockFourcs });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    expect(
      (
        await submit(
          url,
          requestXml({ card: "9900000000000004", tranId: "MALFORMED" }),
        )
      ).xml,
    ).toBe("<invalid");
    const mismatched = await submit(
      url,
      requestXml({ card: "9900000000000005", tranId: "MISMATCH" }),
    );
    expect(mismatched.xml).toContain("<TranId>WRONGECHO</TranId>");
    const service = await submit(
      url,
      requestXml({ card: "9900000000000006", tranId: "SERVICE" }),
    );
    expect(service.xml).toContain("<ResultCode>GeneralError</ResultCode>");
    expect(service.xml).toContain(
      "<FinancialResultCode>Approved</FinancialResultCode>",
    );
    const operation = await submit(
      url,
      requestXml({ card: "9900000000000007", tranId: "OPERATION" }),
    );
    expect(operation.xml).toContain(
      "<SSISProcessTransactionResult>UnableToProcessInternalProblem</SSISProcessTransactionResult>",
    );
    expect(operation.xml).toContain("<ResultCode>OK</ResultCode>");
    expect(operation.xml).toContain(
      "<FinancialResultCode>Approved</FinancialResultCode>",
    );
    expect(
      ledger(files.mockFourcs).map((row) => [
        row.tran_id,
        row.final_outcome,
        row.effect_count,
      ]),
    ).toEqual([
      ["MALFORMED", "Approved", 1],
      ["MISMATCH", "Approved", 1],
      ["OPERATION", "Approved", 1],
      ["SERVICE", "Approved", 1],
    ]);
  } finally {
    await app.close();
  }
});

test("XML validation rejects ambiguous structure, unsafe declarations, unsupported input, and oversize bodies without a ledger entry", async () => {
  await using files = await isolatedDatabases();
  const app = await createMockFourcs({ databasePath: files.mockFourcs });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const valid = requestXml();
    for (const invalid of [
      valid.replace(
        "<Amount>75.00</Amount>",
        "<Amount>75.00</Amount><Amount>1.00</Amount>",
      ),
      valid.replace(
        "<Amount>75.00</Amount>",
        "<Amount>75.00<Amount>1.00</Amount></Amount>",
      ),
      valid.replace("<Amount>75.00</Amount>", "<Amount>100000000.00</Amount>"),
      valid.replace("<Amount>75.00</Amount>", "<Amount>0.00</Amount>"),
      valid.replace("<Amount>75.00</Amount>", "<Amount>1.001</Amount>"),
      valid.replace("<Amount>75.00</Amount>", "<Amount>1e2</Amount>"),
      valid.replace("<Currency>XCD</Currency>", "<Currency>USD</Currency>"),
      valid.replace("AuthAndPost", "AuthOnly"),
      valid.replace("9900000000000001", "4111111111111111"),
      valid.replace(
        "<Invoice>INV1</Invoice>",
        "<Invoice>&lt;attack&gt;</Invoice>",
      ),
      valid.replace(
        "<TranId>TXN1</TranId>",
        "<TranId>01234567890123456</TranId>",
      ),
      valid.replace("<TranId>TXN1</TranId>", "<TranId>TXN1'</TranId>"),
      valid.replace("<request>", "<request><Unknown>field</Unknown>"),
      valid.replace(
        "<request>",
        "<request><MerchantKey>mock-provider-key-b</MerchantKey>",
      ),
      valid.replace("<request>", '<request xmlns="urn:wrong">'),
      valid.replace("http://equament.com/Schemas/Fmx/ssis", "urn:wrong"),
      valid.replace("http://schemas.xmlsoap.org/soap/envelope/", "urn:wrong"),
      valid.replace("<request>", '<request arbitrary="value">'),
      valid.replace(
        "<MerchantKey>",
        '<MerchantKey xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
      ),
      valid.replace('<?xml version="1.0"?>', '<?xml version="1.1"?>'),
      valid.replace(
        '<?xml version="1.0"?>',
        '<!DOCTYPE envelope [<!ENTITY injected SYSTEM "file:///etc/passwd">]>',
      ),
      valid.replace("<Invoice>INV1</Invoice>", "<Invoice>&unknown;</Invoice>"),
      valid.replace("</request>", "</request><request/>"),
      valid.replace("</s:Body>", "</s:Body><s:Body/>"),
      valid.replace(
        "<Address>Fixture Address</Address>",
        "<Address><script>alert(1)</script></Address>",
      ),
    ]) {
      const response = await submit(url, invalid);
      expect(response.status, invalid).toBe(400);
      expect(response.xml).not.toContain("file:///etc/passwd");
    }
    expect((await submit(url, "x".repeat(16_385))).status).toBe(413);
    expect(
      (await submit(url, requestXml({ key: "mock-provider-key-wrong" }))).xml,
    ).toContain("<ResultCode>SecurityError</ResultCode>");
    expect(ledger(files.mockFourcs)).toHaveLength(0);
    const accepted = await submit(url, valid.replace("75.00", "99999999.99"));
    expect(accepted.xml).toContain("<Amount>99999999.99</Amount>");
    expect(ledger(files.mockFourcs)[0]?.amount_minor).toBe(9_999_999_999);
  } finally {
    await app.close();
  }
});

test("synthetic serialization preserves exact minor units and escapes XML metacharacters", async () => {
  await using files = await isolatedDatabases();
  const app = await createMockFourcs({ databasePath: files.mockFourcs });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const input = {
      merchantKey: "mock-provider-key-a",
      invoice: "INV1",
      tranId: "CENT",
      amountMinor: 1,
      currency: "XCD",
      mockPaymentMethodRef: "pm_mock_approved",
    } as const;
    const xml = buildFourcsRequest(input);
    expect(xml).toContain("<Amount>0.01</Amount>");
    const response = await submit(url, xml);
    expect(response.status).toBe(200);
    expect(response.xml).toContain("<Amount>0.01</Amount>");
    const malicious = buildFourcsRequest({
      ...input,
      merchantKey: "synthetic<&\"'>key",
      tranId: "ESCAPED",
    });
    expect(malicious).toContain(
      "<MerchantKey>synthetic&lt;&amp;&quot;&apos;&gt;key</MerchantKey>",
    );
    expect((await submit(url, malicious)).xml).toContain(
      "<ResultCode>SecurityError</ResultCode>",
    );
    const prefixed = requestXml({ tranId: "PREFIX" })
      .replaceAll("s:Envelope", "env:Envelope")
      .replaceAll("xmlns:s=", "xmlns:env=")
      .replaceAll("s:Body", "env:Body");
    expect((await submit(url, prefixed)).xml).toContain(
      "<FinancialResultCode>Approved</FinancialResultCode>",
    );
    expect(
      ledger(files.mockFourcs).map((row) => [row.tran_id, row.amount_minor]),
    ).toEqual([
      ["CENT", 1],
      ["PREFIX", 7500],
    ]);
  } finally {
    await app.close();
  }
});

test("transport rejects an unsupported action or media type and never executes the repeat operation", async () => {
  await using files = await isolatedDatabases();
  const app = await createMockFourcs({ databasePath: files.mockFourcs });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const wrongAction = await fetch(`${url}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "text/xml", soapaction: "wrong" },
      body: requestXml(),
    });
    expect(wrongAction.status).toBe(400);
    const wrongMedia = await fetch(`${url}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/soap+xml", soapaction: action },
      body: requestXml(),
    });
    expect(wrongMedia.status).toBe(415);
    for (const media of ["text/plain", "application/json"]) {
      const response = await fetch(`${url}${endpoint}`, {
        method: "POST",
        headers: { "content-type": media, soapaction: action },
        body:
          media === "application/json"
            ? JSON.stringify(requestXml())
            : requestXml(),
      });
      expect(response.status, media).toBe(415);
      expect(ledger(files.mockFourcs)).toEqual([]);
    }
    expect(
      (
        await submit(
          url,
          requestXml().replaceAll(
            "SSISProcessTransaction",
            "SSISProcessTransactionRepeat",
          ),
        )
      ).status,
    ).toBe(400);
    expect(ledger(files.mockFourcs)).toEqual([]);
    expect((await submit(url, requestXml())).xml).toContain(
      "<FinancialResultCode>Approved</FinancialResultCode>",
    );
  } finally {
    await app.close();
  }
});
