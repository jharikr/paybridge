import { Ajv2020 } from "ajv/dist/2020.js";
import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { expect, test } from "vitest";
import { isolatedDatabases } from "../support/databases.ts";
import { startNodeProcess } from "../support/process.ts";
import { mockEntry, ready, rows } from "../provider/support.ts";
import { contractAt, compareResponse } from "../contracts/support.ts";

const path = "/TranSvcs/ssis.asmx";
const action = '"http://equament.com/Schemas/Fmx/ssis/SSISProcessTransaction"';
const xml =
  '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><SSISProcessTransaction xmlns="http://equament.com/Schemas/Fmx/ssis"><request><MerchantKey>mock-provider-key-a</MerchantKey><TranType>AuthAndPost</TranType><Amount>75.00</Amount><Currency>XCD</Currency><Invoice>INV1</Invoice><TranId>CONTRACT1</TranId><CardNumber>9900000000000001</CardNumber><ExpiryMMYY>1230</ExpiryMMYY><VerificationValue>123</VerificationValue><CardholderName>Fixture Payer</CardholderName><Address>Fixture Address</Address></request></SSISProcessTransaction></s:Body></s:Envelope>';

test("the generated SOAP contract matches actual media, action, layered results, protocol errors and failure fixtures", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({
    entrypoint: mockEntry,
    args: [files.mockFourcs, "0"],
  });
  try {
    const { url } = ready.assert(await server.message());
    const contract = await contractAt(url);
    const operation = type({
      description: "string",
      parameters: type({
        name: "string",
        in: "string",
        required: "boolean",
        schema: "object",
      }).array(),
      requestBody: {
        required: "boolean",
        content: { "text/xml": { schema: "object" } },
      },
    }).assert(contract.paths[path]?.["post"]);
    const ajv = new Ajv2020({ strict: false });
    const header = operation.parameters.find(
      (parameter) =>
        parameter.in === "header" &&
        parameter.name.toLowerCase() === "soapaction",
    );
    if (!header) throw new Error("SOAPAction header contract is missing");
    expect(header.required).toBe(true);
    expect(ajv.compile(header.schema)(action)).toBe(true);
    expect(ajv.compile(header.schema)("wrong")).toBe(false);
    expect(operation.requestBody.required).toBe(true);
    const validBody = ajv.compile(
      operation.requestBody.content["text/xml"].schema,
    );
    expect(validBody(xml)).toBe(true);
    expect(validBody({ request: xml })).toBe(false);
    expect(operation.description).toContain("synthetic");
    for (const scenario of [
      {
        body: xml.replace("mock-provider-key-a", "mock-provider-key-wrong"),
        status: 200,
        result: "<ResultCode>SecurityError</ResultCode>",
      },
      {
        body: xml,
        status: 400,
        result: "<ResultCode>ParameterError</ResultCode>",
        action: "wrong",
      },
      {
        body: xml.replace("AuthAndPost", "AuthOnly"),
        status: 400,
        result: "<ResultCode>ParameterError</ResultCode>",
      },
      {
        body: "x".repeat(16_385),
        status: 413,
        result: "<ResultCode>ParameterError</ResultCode>",
      },
      {
        body: xml,
        status: 415,
        result: "<ResultCode>ParameterError</ResultCode>",
        media: "application/soap+xml",
      },
      {
        body: xml,
        status: 415,
        result: "<ResultCode>ParameterError</ResultCode>",
        media: "application/json",
      },
    ]) {
      const response = await fetch(url + path, {
        method: "POST",
        headers: {
          "content-type": scenario.media ?? "text/xml; charset=utf-8",
          soapaction: scenario.action ?? action,
        },
        body: scenario.body,
      });
      expect(response.status, scenario.result).toBe(scenario.status);
      expect(response.headers.get("content-type")).toBe(
        scenario.status === 200 ? "text/xml; charset=utf-8" : "text/xml",
      );
      expect(
        await compareResponse({
          contract,
          path,
          method: "post",
          response,
          status: scenario.status,
          headers: [],
        }),
      ).toContain(scenario.result);
    }
    expect(
      rows(files.mockFourcs, "SELECT tran_id FROM mock_transactions"),
    ).toEqual([]);
    for (const result of [
      "<FinancialResultCode>Approved</FinancialResultCode>",
      "<ResultCode>DuplicateTransaction</ResultCode>",
    ]) {
      const response = await fetch(url + path, {
        method: "POST",
        headers: { "content-type": "text/xml", soapaction: action },
        body: xml,
      });
      expect(response.headers.get("content-type")).toBe(
        "text/xml; charset=utf-8",
      );
      const body = await compareResponse({
        contract,
        path,
        method: "post",
        response,
        status: 200,
        headers: [],
      });
      expect(body).toContain(result);
      expect(body).toContain("<TranId>CONTRACT1</TranId>");
    }
    const malformed = await fetch(url + path, {
      method: "POST",
      headers: { "content-type": "text/xml", soapaction: action },
      body: xml
        .replace("CONTRACT1", "MALFORMED")
        .replace("9900000000000001", "9900000000000004"),
    });
    expect(
      await compareResponse({
        contract,
        path,
        method: "post",
        response: malformed,
        status: 200,
        headers: [],
      }),
    ).toBe("<invalid");
    const lost = () =>
      fetch(url + path, {
        method: "POST",
        headers: { "content-type": "text/xml", soapaction: action },
        body: xml
          .replace("CONTRACT1", "LOST")
          .replace("9900000000000001", "9900000000000008"),
      });
    await expect(lost()).rejects.toThrow();
    expect(
      await compareResponse({
        contract,
        path,
        method: "post",
        response: await lost(),
        status: 200,
        headers: [],
      }),
    ).toContain("<ResultCode>DuplicateTransaction</ResultCode>");
    expect(
      rows(
        files.mockFourcs,
        "SELECT tran_id,effect_count FROM mock_transactions ORDER BY tran_id",
      ),
    ).toEqual([
      { tran_id: "CONTRACT1", effect_count: 1 },
      { tran_id: "LOST", effect_count: 1 },
      { tran_id: "MALFORMED", effect_count: 1 },
    ]);
  } finally {
    await server.stop();
  }
});

test("an unexpected mock response failure uses its XML 500 contract and preserves the accepted outcome", async () => {
  await using files = await isolatedDatabases();
  const server = startNodeProcess({
    entrypoint: fileURLToPath(
      new URL("./fixtures/failing-server.ts", import.meta.url),
    ),
    args: [files.mockFourcs],
  });
  try {
    const { url } = ready.assert(await server.message());
    const contract = await contractAt(url);
    const submit = () =>
      fetch(url + path, {
        method: "POST",
        headers: { "content-type": "text/xml", soapaction: action },
        body: xml,
      });
    const failed = await submit();
    expect(failed.headers.get("content-type")).toBe("text/xml");
    const body = await compareResponse({
      contract,
      path,
      method: "post",
      response: failed,
      status: 500,
      headers: [],
    });
    expect(body).toContain(
      "<SSISProcessTransactionResult>UnableToProcessInternalProblem</SSISProcessTransactionResult>",
    );
    expect(body).toContain("<ResultCode>ParameterError</ResultCode>");
    expect(
      await compareResponse({
        contract,
        path,
        method: "post",
        response: await submit(),
        status: 200,
        headers: [],
      }),
    ).toContain("<ResultCode>DuplicateTransaction</ResultCode>");
    expect(
      rows(
        files.mockFourcs,
        "SELECT tran_id,final_outcome,effect_count FROM mock_transactions",
      ),
    ).toEqual([
      { tran_id: "CONTRACT1", final_outcome: "Approved", effect_count: 1 },
    ]);
  } finally {
    await server.stop();
  }
});
