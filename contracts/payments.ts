import { type } from "arktype";

export const merchantId = type("string > 0").brand("MerchantId");
export const paymentId = type(/^pi_[a-f0-9]{32}$/).brand("PaymentId");
export const paymentStatus = type(
  "'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED'",
);
// SQLite must preserve the original text, including valid surrogate pairs.
const storedText = type(
  /^(?:[^\u0000\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/,
);
const boundedText = (limit: number) =>
  storedText
    .atLeastLength(1)
    .atMostLength(limit)
    .describe(
      `Length is 1 to ${limit} UTF-16 code units at runtime. JSON Schema counts Unicode code points. NUL and unpaired surrogates are rejected.`,
    );
export const createPaymentInput = type({
  merchantReference: boundedText(128),
  amount: type("1 <= number.integer <= 9999999999").describe(
    "Minor units. XCD has two decimal places; the mock adapter ceiling is 9,999,999,999 minor units.",
  ),
  currency: "'XCD'",
  "description?": storedText
    .atMostLength(256)
    .describe(
      "At most 256 UTF-16 code units at runtime. NUL and unpaired surrogates are rejected. Stored as inert text.",
    ),
  returnUrl: boundedText(2048).describe(
    "Absolute HTTP or HTTPS URL at the authenticated merchant's configured return origin. No URL credentials, fragment, control characters, or unpaired surrogates. HTTP is permitted only for the local fixtures.",
  ),
  "+": "reject",
});
export type CreatePaymentInput = typeof createPaymentInput.infer;
export const commandKey = boundedText(128);
export const paymentSnapshot = type({
  id: paymentId,
  merchantReference: "string",
  amount: "1 <= number.integer <= 9999999999",
  currency: "'XCD'",
  status: paymentStatus,
  revision: "number.integer >= 1",
  createdAt: "string",
  updatedAt: "string",
  latestAttempt: "null",
  "+": "reject",
});
export const creationAcknowledgment = paymentSnapshot.merge({
  checkoutUrl: "string",
});
