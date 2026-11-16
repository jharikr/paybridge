import { type } from "arktype";
import {
  createPaymentInput,
  confirmPaymentInput,
  paymentId,
  paymentSnapshot,
  paymentRevision,
} from "./payments.ts";

export const merchantFixture = type("'merchant-a' | 'merchant-b'");
export type MerchantFixture = typeof merchantFixture.infer;
export const orderId = type(/^ord_[a-f0-9]{32}$/).brand("OrderId");
export const merchantCommandId =
  type(/^mc_[a-f0-9]{32}$/).brand("MerchantCommandId");
export const createOrderInput = createPaymentInput
  .omit("merchantReference", "returnUrl")
  .merge({
    businessReference: createPaymentInput.get("merchantReference"),
    "+": "reject",
  });
export const orderPaidState = type({ state: "'UNPAID'", paidAt: "null" }).or({
  state: "'PAID'",
  paidAt: "string",
});
export const orderView = createOrderInput
  .onUndeclaredKey("ignore")
  .merge({
    id: orderId,
    merchantId: merchantFixture,
    paymentIntentId: paymentId.or("null"),
  })
  .and(orderPaidState)
  .onUndeclaredKey("reject");
export const merchantConfirmationInput = confirmPaymentInput.merge({
  commandNumber: "1 <= number.integer <= 9007199254740991",
  "+": "reject",
});
export const merchantCommandSummary = type({
  id: merchantCommandId,
  operation: "'create' | 'confirm'",
  commandNumber: "number.integer >= 1",
  status: "'PREPARED' | 'COMPLETED'",
  "+": "reject",
});
export const merchantCommandList = type({
  commands: merchantCommandSummary.array(),
  "+": "reject",
});
export const merchantPaymentSnapshot = paymentSnapshot
  .pick("merchantReference", "amount", "currency", "status", "revision")
  .merge({
    paymentIntentId: paymentId,
    revision: paymentRevision,
    "+": "reject",
  });
export const merchantReturnResult = type({
  orderId,
  payment: merchantPaymentSnapshot,
})
  .and(orderPaidState)
  .onUndeclaredKey("reject");
