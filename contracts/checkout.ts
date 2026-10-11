import { type } from "arktype";
import { paymentId, paymentRevision } from "./payments.ts";

export const checkoutParams = type({ paymentId, "+": "reject" });
export const checkoutQuery = type({ "token?": "unknown", "+": "reject" });
export const checkoutCapability = type(/^[A-Za-z0-9_-]{43}$/);
export const checkoutDisplay = type({
  paymentIntentId: paymentId,
  amount: "1 <= number.integer <= 9999999999",
  currency: "'XCD'",
  status: "'PENDING' | 'FAILED'",
  revision: paymentRevision,
  confirmPath: "string",
  leavePath: "string",
  "+": "reject",
});
