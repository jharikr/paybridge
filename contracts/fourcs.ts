import { type } from "arktype";
import { SaxesParser } from "saxes";

export const soapNamespace = "http://schemas.xmlsoap.org/soap/envelope/";
export const fourcsNamespace = "http://equament.com/Schemas/Fmx/ssis";
export const soapAction = `"${fourcsNamespace}/SSISProcessTransaction"`;
export const soapPath = "/TranSvcs/ssis.asmx";
export const soapBodyLimit = 16_384;
export const maxAmountMinor = 9_999_999_999;

export const mockPaymentMethodRef = type.enumerated(
  "pm_mock_approved",
  "pm_mock_declined",
  "pm_mock_incomplete",
  "pm_mock_malformed",
  "pm_mock_mismatched_echo",
  "pm_mock_invalid_service",
  "pm_mock_invalid_operation",
  "pm_mock_lost_response",
  "pm_mock_delayed_response",
  "pm_mock_held_before_acceptance",
  "pm_mock_fail_before_acceptance",
  "pm_mock_decline_lost_response",
);
export type MockPaymentMethodRef = typeof mockPaymentMethodRef.infer;
const fixtureCards = {
  pm_mock_approved: "9900000000000001",
  pm_mock_declined: "9900000000000002",
  pm_mock_incomplete: "9900000000000003",
  pm_mock_malformed: "9900000000000004",
  pm_mock_mismatched_echo: "9900000000000005",
  pm_mock_invalid_service: "9900000000000006",
  pm_mock_invalid_operation: "9900000000000007",
  pm_mock_lost_response: "9900000000000008",
  pm_mock_delayed_response: "9900000000000009",
  pm_mock_held_before_acceptance: "9900000000000010",
  pm_mock_fail_before_acceptance: "9900000000000011",
  pm_mock_decline_lost_response: "9900000000000012",
} satisfies Record<MockPaymentMethodRef, string>;
export const providerAccountFixtures = [
  { providerAccount: "mock-account-a", merchantKey: "mock-provider-key-a" },
  { providerAccount: "mock-account-b", merchantKey: "mock-provider-key-b" },
];

const providerIdentifier = type(/^[A-Za-z0-9]{1,16}$/);
const amountMinor = type("number.integer >= 1").atMost(maxAmountMinor);
const requestFields = type({
  MerchantKey: "8 <= string <= 64",
  TranType: "'AuthAndPost'",
  Amount: /^(0|[1-9][0-9]{0,7})\.[0-9]{2}$/,
  Currency: "'XCD'",
  Invoice: providerIdentifier.brand("ProviderInvoice"),
  TranId: providerIdentifier.brand("ProviderTranId"),
  CardNumber: /^[0-9]{16}$/,
  ExpiryMMYY: "'1230'",
  VerificationValue: "'123'",
  "CardholderName?": "'Fixture Payer' | ''",
  "Address?": "'Fixture Address' | ''",
  "+": "reject",
});
const requestInput = type({
  merchantKey: "8 <= string <= 64",
  tranId: providerIdentifier,
  invoice: providerIdentifier,
  amountMinor,
  currency: "'XCD'",
  mockPaymentMethodRef,
  "+": "reject",
});
export type FourcsRequestInput = typeof requestInput.infer;

export class SoapProtocolError extends Error {
  constructor() {
    super("Invalid synthetic SOAP request");
  }
}

interface XmlElement {
  local: string;
  uri: string;
  children: XmlElement[];
  text: string;
}
function parseXml(xml: string): XmlElement {
  if (Buffer.byteLength(xml) > soapBodyLimit || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new SoapProtocolError();
  const parser = new SaxesParser({
    xmlns: true,
    defaultXMLVersion: "1.0",
    forceXMLVersion: true,
  });
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let count = 0;
  parser.on("error", () => {
    throw new SoapProtocolError();
  });
  parser.on("xmldecl", (declaration) => {
    if (
      declaration.version !== "1.0" ||
      (declaration.encoding && declaration.encoding.toLowerCase() !== "utf-8")
    )
      throw new SoapProtocolError();
  });
  parser.on("doctype", () => {
    throw new SoapProtocolError();
  });
  parser.on("processinginstruction", () => {
    throw new SoapProtocolError();
  });
  parser.on("opentag", (tag) => {
    if (++count > 80 || stack.length >= 8) throw new SoapProtocolError();
    if (
      Object.values(tag.attributes).some(
        (attribute) => attribute.uri !== "http://www.w3.org/2000/xmlns/",
      )
    )
      throw new SoapProtocolError();
    const element: XmlElement = {
      local: tag.local,
      uri: tag.uri,
      children: [],
      text: "",
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(element);
    else root = element;
    stack.push(element);
  });
  const text = (value: string) => {
    const element = stack.at(-1);
    if (element) element.text += value;
    else if (value.trim()) throw new SoapProtocolError();
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.write(xml).close();
  if (!root) throw new SoapProtocolError();
  return root;
}
function onlyChild(
  element: XmlElement,
  local: string,
  uri: string,
): XmlElement {
  const [child] = element.children;
  if (
    element.text.trim() ||
    element.children.length !== 1 ||
    !child ||
    child.local !== local ||
    child.uri !== uri
  )
    throw new SoapProtocolError();
  return child;
}
function soapOperation(xml: string, operation: string): XmlElement {
  const root = parseXml(xml);
  if (root.local !== "Envelope" || root.uri !== soapNamespace)
    throw new SoapProtocolError();
  return onlyChild(
    onlyChild(root, "Body", soapNamespace),
    operation,
    fourcsNamespace,
  );
}
function scalarFields(element: XmlElement): Record<string, string> {
  if (element.text.trim()) throw new SoapProtocolError();
  const fields: Record<string, string> = Object.create(null);
  for (const child of element.children) {
    if (
      child.uri !== fourcsNamespace ||
      child.children.length ||
      Object.hasOwn(fields, child.local)
    )
      throw new SoapProtocolError();
    fields[child.local] = child.text;
  }
  return fields;
}

export function parseFourcsRequest(xml: string) {
  const fields = requestFields(
    scalarFields(
      onlyChild(
        soapOperation(xml, "SSISProcessTransaction"),
        "request",
        fourcsNamespace,
      ),
    ),
  );
  if (fields instanceof type.errors) throw new SoapProtocolError();
  const account = providerAccountFixtures.find(
    (fixture) => fixture.merchantKey === fields.MerchantKey,
  );
  if (!account) return { kind: "unauthorized" } as const;
  const fixture = Object.entries(fixtureCards).find(
    ([, card]) => card === fields.CardNumber,
  );
  if (!fixture) throw new SoapProtocolError();
  const minor = Number(BigInt(fields.Amount.replace(".", "")));
  if (!amountMinor.allows(minor)) throw new SoapProtocolError();
  return {
    kind: "request" as const,
    providerAccount: account.providerAccount,
    tranId: fields.TranId,
    invoice: fields.Invoice,
    amountMinor: minor,
    currency: fields.Currency,
    paymentMethodRef: mockPaymentMethodRef.assert(fixture[0]),
  };
}
export type FourcsRequest = Extract<
  ReturnType<typeof parseFourcsRequest>,
  { kind: "request" }
>;

export function formatFourcsAmount(minor: number): string {
  amountMinor.assert(minor);
  const amount = BigInt(minor);
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`;
}
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function xmlFields(fields: Record<string, string | null>): string {
  return Object.entries(fields)
    .map(([key, value]) => `<${key}>${escapeXml(value ?? "")}</${key}>`)
    .join("");
}
function envelope(operation: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${soapNamespace}"><soap:Body><${operation} xmlns="${fourcsNamespace}">${body}</${operation}></soap:Body></soap:Envelope>`;
}
export function buildFourcsRequest(input: FourcsRequestInput): string {
  const value = requestInput.assert(input);
  return envelope(
    "SSISProcessTransaction",
    `<request>${xmlFields({
      MerchantKey: value.merchantKey,
      TranType: "AuthAndPost",
      Amount: formatFourcsAmount(value.amountMinor),
      Currency: value.currency,
      Invoice: value.invoice,
      TranId: value.tranId,
      CardNumber: fixtureCards[value.mockPaymentMethodRef],
      ExpiryMMYY: "1230",
      VerificationValue: "123",
      CardholderName: "Fixture Payer",
      Address: "Fixture Address",
    })}</request>`,
  );
}

export function buildFourcsResponse({
  operationResult = "OK",
  resultCode,
  financialResult = "",
  request,
  hostReference = null,
  approvalCode = null,
}: {
  operationResult?: string;
  resultCode: string;
  financialResult?: string;
  request?: Pick<
    FourcsRequestInput,
    "invoice" | "tranId" | "amountMinor" | "currency"
  >;
  hostReference?: string | null;
  approvalCode?: string | null;
}): string {
  return envelope(
    "SSISProcessTransactionResponse",
    `<SSISProcessTransactionResult>${escapeXml(operationResult)}</SSISProcessTransactionResult><response>${xmlFields(
      {
        Invoice: request?.invoice ?? "",
        TranId: request?.tranId ?? "",
        ErrorMessage: "",
        ResultCode: resultCode,
        FinancialResultCode: financialResult,
        Amount: request ? formatFourcsAmount(request.amountMinor) : "",
        Currency: request?.currency ?? "",
        ApprovalCode: approvalCode,
        HostReference: hostReference,
        BatchId: null,
        AVSResult: null,
        NetworkResponseCode: null,
      },
    )}</response>`,
  );
}

const responseFields = type({
  Invoice: providerIdentifier,
  TranId: providerIdentifier,
  Amount: /^(0|[1-9][0-9]{0,7})\.[0-9]{2}$/,
  Currency: /^[A-Z]{3}$/,
  ResultCode: /^[A-Za-z]{1,64}$/,
  FinancialResultCode: /^[A-Za-z]{0,32}$/,
  "ErrorMessage?": "string <= 512",
  "ApprovalCode?": /^[A-Za-z0-9]{0,12}$/,
  "HostReference?": /^[A-Za-z0-9]{0,16}$/,
  "BatchId?": /^[A-Za-z0-9]{0,16}$/,
  "AVSResult?": /^[A-Za-z0-9]{0,10}$/,
  "NetworkResponseCode?": /^[A-Za-z0-9]{0,32}$/,
});

export function parseFourcsResponse(xml: string) {
  const operation = soapOperation(xml, "SSISProcessTransactionResponse");
  const result = operation.children.find(
    (child) => child.local === "SSISProcessTransactionResult",
  );
  const response = operation.children.find(
    (child) => child.local === "response",
  );
  if (
    operation.text.trim() ||
    operation.children.length !== 2 ||
    !result ||
    !response ||
    result.uri !== fourcsNamespace ||
    response.uri !== fourcsNamespace ||
    result.children.length ||
    !/^[A-Za-z]{1,64}$/.test(result.text)
  )
    throw new SoapProtocolError();
  const fields = responseFields(scalarFields(response));
  if (fields instanceof type.errors) throw new SoapProtocolError();
  return {
    operation: result.text,
    service: fields.ResultCode,
    financial: fields.FinancialResultCode,
    invoice: fields.Invoice,
    tranId: fields.TranId,
    amount: fields.Amount,
    currency: fields.Currency,
    hostReference: fields.HostReference || null,
    approvalCode: fields.ApprovalCode || null,
    batchId: fields.BatchId || null,
    avsResult: fields.AVSResult || null,
    networkResponseCode: fields.NetworkResponseCode || null,
  };
}
