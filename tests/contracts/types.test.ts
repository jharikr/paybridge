import { expect, expectTypeOf, test } from "vitest";
import { orderView, merchantReturnResult } from "../../contracts/merchant.ts";
import { finalEvidence } from "../../contracts/reconciliation.ts";
import { type } from "arktype";

test("order and evidence contracts reject contradictory states and infer their dependent fields", () => {
  const order = {
    id: `ord_${"a".repeat(32)}`,
    merchantId: "merchant-a",
    businessReference: "ORDER",
    amount: 10,
    currency: "XCD",
    paymentIntentId: null,
  };
  expect(
    orderView.allows({
      ...order,
      state: "UNPAID",
      paidAt: "2026-10-11T00:00:00.000Z",
    }),
  ).toBe(false);
  expect(orderView.allows({ ...order, state: "PAID", paidAt: null })).toBe(
    false,
  );
  const unpaid = orderView.assert({ ...order, state: "UNPAID", paidAt: null });
  if (unpaid.state === "UNPAID")
    expectTypeOf(unpaid.paidAt).toEqualTypeOf<null>();
  else expectTypeOf(unpaid.paidAt).toEqualTypeOf<string>();
  const result = merchantReturnResult.assert({
    orderId: order.id,
    state: "PAID",
    paidAt: "2026-10-11T00:00:00.000Z",
    payment: {
      paymentIntentId: `pi_${"b".repeat(32)}`,
      merchantReference: "ORDER",
      amount: 10,
      currency: "XCD",
      status: "SUCCEEDED",
      revision: 3,
    },
  });
  if (result.state === "PAID")
    expectTypeOf(result.paidAt).toEqualTypeOf<string>();
  const evidence = finalEvidence.assert({
    providerAccount: "mock-account-a",
    tranId: "TRAN1",
    invoice: "INV1",
    amountMinor: 10,
    currency: "XCD",
    finalOutcome: "Approved",
    effectCount: 1,
    hostReference: "a".repeat(16),
    approvalCode: "MOCK01",
    acceptedAt: "2026-10-11T00:00:00.000Z",
    requestFingerprint: "b".repeat(64),
  });
  if (evidence.finalOutcome === "Approved") {
    expectTypeOf(evidence.effectCount).toEqualTypeOf<1>();
    expectTypeOf(evidence.approvalCode).toEqualTypeOf<string>();
  } else {
    expectTypeOf(evidence.effectCount).toEqualTypeOf<0>();
    expectTypeOf(evidence.approvalCode).toEqualTypeOf<null>();
  }
  expect(finalEvidence({ ...evidence, effectCount: 0 })).toBeInstanceOf(
    type.errors,
  );
});

test("provider submission, response and final evidence retain distinct transaction and invoice identities", async () => {
  const {
    providerTranId,
    providerInvoice,
    fourcsRequestInput,
    parseFourcsResponse,
  } = await import("../../contracts/fourcs.ts");
  expectTypeOf<typeof providerTranId.infer>().not.toEqualTypeOf<
    typeof providerInvoice.infer
  >();
  expectTypeOf<typeof fourcsRequestInput.infer.tranId>().toEqualTypeOf<
    typeof providerTranId.infer
  >();
  expectTypeOf<typeof fourcsRequestInput.infer.invoice>().toEqualTypeOf<
    typeof providerInvoice.infer
  >();
  expectTypeOf<
    ReturnType<typeof parseFourcsResponse>["tranId"]
  >().toEqualTypeOf<typeof providerTranId.infer>();
  expectTypeOf<typeof finalEvidence.infer.tranId>().toEqualTypeOf<
    typeof providerTranId.infer
  >();
  expectTypeOf<typeof finalEvidence.infer.invoice>().toEqualTypeOf<
    typeof providerInvoice.infer
  >();
});
