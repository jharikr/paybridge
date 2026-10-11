import {
  confirmationAcknowledgment,
  paymentSnapshot,
} from "../../contracts/payments.ts";
import { merchantReturnResult } from "../../contracts/merchant.ts";
import { checkoutDisplay } from "../../contracts/checkout.ts";
import type { MockPaymentMethodRef } from "../../contracts/fourcs.ts";
import { requireDemo, waitFor } from "./process.ts";
import { demoSystem } from "./system.ts";
import { count, financialFingerprint } from "./evidence.ts";
import {
  post,
  get,
  credential,
  createBoundOrder,
  readOrder,
  readPayment,
  checkoutPath,
  type BoundOrder,
} from "./http.ts";
import { operatorCommands } from "./operator.ts";

export async function runJourney(
  directory: string,
  paybridgePort: number,
  signal: AbortSignal,
) {
  const system = await demoSystem(directory, paybridgePort, signal);
  try {
    const direct = await createBoundOrder({
      origin: system.merchant,
      merchant: "merchant-a",
      reference: "demo-shared-order",
    });
    const checkout = await createBoundOrder({
      origin: system.merchant,
      merchant: "merchant-b",
      reference: "demo-shared-order",
    });
    const cancelled = await createBoundOrder({
      origin: system.merchant,
      merchant: "merchant-a",
      reference: "demo-cancelled",
    });
    const incomplete = await createBoundOrder({
      origin: system.merchant,
      merchant: "merchant-a",
      reference: "demo-incomplete",
    });
    const lostSuccess = await createBoundOrder({
      origin: system.merchant,
      merchant: "merchant-b",
      reference: "demo-lost-success",
    });
    const lostFailure = await createBoundOrder({
      origin: system.merchant,
      merchant: "merchant-b",
      reference: "demo-lost-failure",
    });
    const absent = await createBoundOrder({
      origin: system.merchant,
      merchant: "merchant-a",
      reference: "demo-absent",
    });
    const orders = [
      direct,
      checkout,
      cancelled,
      incomplete,
      lostSuccess,
      lostFailure,
      absent,
    ];
    signal.throwIfAborted();
    const snapshot = (order: BoundOrder) =>
      readPayment({
        origin: system.paybridge,
        id: order.payment.id,
        merchant: order.merchant,
      });
    async function leave(order: BoundOrder, status: string) {
      const before = await snapshot(order);
      requireDemo(before.status === status, "leave_state_mismatch");
      const response = await post({
        origin: system.paybridge,
        path: checkoutPath(order, "leave"),
      });
      requireDemo(
        response.status === 303 && (await response.text()) === "",
        "leave_failed",
      );
      requireDemo(
        response.headers.get("location") ===
          `${system.merchant}/${order.merchant}/payment-return?paymentId=${order.payment.id}`,
        "unsafe_return_location",
      );
      requireDemo(
        JSON.stringify(await snapshot(order)) === JSON.stringify(before),
        "leave_changed_payment",
      );
    }
    async function confirm(
      order: BoundOrder,
      method: MockPaymentMethodRef,
      commandNumber: number,
      revision: number,
    ) {
      return post({
        origin: system.merchant,
        path: `${order.path}/confirm`,
        body: {
          commandNumber,
          mockPaymentMethodRef: method,
          expectedRevision: revision,
        },
      });
    }
    async function accepted(
      order: BoundOrder,
      method: MockPaymentMethodRef,
      commandNumber = 1,
      revision = 1,
    ) {
      const response = await confirm(order, method, commandNumber, revision);
      requireDemo(response.status === 202, "direct_confirmation_failed");
      const bytes = await response.text();
      confirmationAcknowledgment.assert(JSON.parse(bytes));
      return bytes;
    }
    await leave(direct, "PENDING");
    const directBytes = await accepted(direct, "pm_mock_declined");
    await leave(direct, "PROCESSING");
    const display = await get(checkout.payment.checkoutUrl);
    requireDemo(display.status === 200, "checkout_display_failed");
    checkoutDisplay.assert(await display.json());
    const checkoutConfirm = () =>
      post({
        origin: system.paybridge,
        path: checkoutPath(checkout, "confirm"),
        body: { mockPaymentMethodRef: "pm_mock_approved", expectedRevision: 1 },
        key: "demo-checkout-confirm",
      });
    const redirect = await checkoutConfirm();
    requireDemo(
      redirect.status === 303 && (await redirect.text()) === "",
      "checkout_confirmation_failed",
    );
    await accepted(incomplete, "pm_mock_incomplete");
    await accepted(lostSuccess, "pm_mock_lost_response");
    await accepted(lostFailure, "pm_mock_decline_lost_response");
    await accepted(absent, "pm_mock_fail_before_acceptance");
    const cancel = () =>
      post({
        origin: system.paybridge,
        path: `/v1/payment-intents/${cancelled.payment.id}/cancel`,
        credential: credential(cancelled.merchant),
      });
    const cancellation = await cancel();
    requireDemo(cancellation.status === 200, "cancellation_failed");
    const cancellationBytes = await cancellation.text();
    requireDemo(
      paymentSnapshot.assert(JSON.parse(cancellationBytes)).status ===
        "CANCELLED",
      "cancellation_not_terminal",
    );
    requireDemo(
      (await (await cancel()).text()) === cancellationBytes,
      "cancellation_replay_changed",
    );
    await leave(cancelled, "CANCELLED");
    requireDemo(
      (await confirm(cancelled, "pm_mock_approved", 1, 2)).status === 409,
      "cancelled_binding_reused",
    );
    for (const order of orders)
      requireDemo(
        (await readOrder(system.merchant, order)).state === "UNPAID",
        "acknowledgment_paid_order",
      );
    const stolen = new URL(direct.payment.checkoutUrl);
    stolen.search = new URL(checkout.payment.checkoutUrl).search;
    requireDemo(
      (await get(stolen)).status === 404,
      "capability_crossed_binding",
    );
    requireDemo(
      (
        await fetch(
          `${system.paybridge}/v1/payment-intents/${direct.payment.id}`,
          { headers: { authorization: `Bearer ${credential("merchant-b")}` } },
        )
      ).status === 404,
      "merchant_isolation_failed",
    );
    requireDemo(
      (
        await get(
          `${system.merchant}/merchant-b/payment-return?paymentId=${direct.payment.id}`,
        )
      ).status === 404,
      "return_isolation_failed",
    );

    await system.checkpoint("commands-accepted");
    await system.stop("merchant-api", "SIGKILL");
    signal.throwIfAborted();
    await system.startWorker();
    await waitFor(
      () =>
        count(
          system.files.paybridge,
          "SELECT count(*) AS count FROM payment_intents WHERE status IN ('SUCCEEDED','FAILED','UNKNOWN','CANCELLED')",
        ),
      (value) => value === 7,
      "outage_financial_completion_timeout",
    );
    await waitFor(
      () =>
        count(
          system.files.paybridge,
          "SELECT count(*) AS count FROM webhook_outbox WHERE attempt_count>0",
        ),
      (value) => value === 7,
      "outage_delivery_attempt_timeout",
    );
    requireDemo(
      count(
        system.files.merchant,
        "SELECT count(*) AS count FROM webhook_inbox",
      ) === 0,
      "outage_received_notification",
    );
    const financial = financialFingerprint(system.files);
    await system.checkpoint("receiver-outage-observed");
    await system.stop("paybridge-worker", "SIGKILL");
    await system.stop("mock", "SIGKILL");
    await system.startMock();
    await system.startMerchant();
    await system.startWorker();
    await system.startInbox();
    await waitFor(
      () =>
        count(
          system.files.merchant,
          "SELECT count(*) AS count FROM webhook_inbox WHERE status='PROCESSED'",
        ),
      (value) => value === 7,
      "inbox_recovery_timeout",
    );
    requireDemo(
      (await readOrder(system.merchant, checkout)).state === "PAID",
      "inbox_payment_not_applied",
    );
    await waitFor(
      () =>
        count(
          system.files.paybridge,
          "SELECT count(*) AS count FROM webhook_outbox WHERE status='DELIVERED'",
        ),
      (value) => value === 7,
      "delivery_completion_timeout",
    );
    requireDemo(
      financialFingerprint(system.files) === financial,
      "delivery_changed_financial_facts",
    );
    await system.checkpoint("delivery-recovered");
    signal.throwIfAborted();
    await leave(direct, "FAILED");
    await leave(absent, "UNKNOWN");
    await leave(checkout, "SUCCEEDED");
    requireDemo(
      (await snapshot(incomplete)).latestAttempt?.failureCode === "Incomplete",
      "incomplete_classification_changed",
    );
    const directReplay = await confirm(direct, "pm_mock_declined", 1, 1);
    requireDemo(
      directReplay.status === 202 &&
        (await directReplay.text()) === directBytes,
      "confirmation_replay_changed",
    );
    const checkoutReplay = await checkoutConfirm();
    requireDemo(
      checkoutReplay.status === 303 &&
        checkoutReplay.headers.get("location") ===
          redirect.headers.get("location") &&
        (await checkoutReplay.text()) === "",
      "checkout_replay_changed",
    );
    requireDemo(
      (await confirm(direct, "pm_mock_approved", 2, 1)).status === 409,
      "stale_confirmation_accepted",
    );
    await accepted(
      direct,
      "pm_mock_approved",
      3,
      (await snapshot(direct)).revision,
    );
    requireDemo(
      (
        await confirm(
          absent,
          "pm_mock_approved",
          2,
          (await snapshot(absent)).revision,
        )
      ).status === 409,
      "unknown_retry_accepted",
    );
    const operator = await operatorCommands(directory, system.files);
    await operator.resolve({
      id: lostSuccess.payment.id,
      name: "success",
      resolution: "SUCCEEDED",
    });
    await operator.resolve({
      id: lostFailure.payment.id,
      name: "failure",
      resolution: "FAILED",
    });
    await accepted(
      lostFailure,
      "pm_mock_approved",
      2,
      (await snapshot(lostFailure)).revision,
    );
    await operator.resolve({
      id: absent.payment.id,
      name: "absent",
      resolution: "ABSENT",
    });
    requireDemo(
      (await snapshot(absent)).status === "UNKNOWN",
      "absent_evidence_changed_state",
    );
    await system.checkpoint("reconciled-with-one-unknown");
    const paidOrders = [direct, checkout, lostSuccess, lostFailure];
    for (const order of paidOrders) {
      signal.throwIfAborted();
      const local = await waitFor(
        () => readOrder(system.merchant, order),
        (value) => value.state === "PAID",
        "inbox_payment_timeout",
      );
      const returning = await get(
        `${system.merchant}/${order.merchant}/payment-return?paymentId=${order.payment.id}`,
      );
      requireDemo(returning.status === 200, "return_failed");
      const result = merchantReturnResult.assert(await returning.json());
      requireDemo(
        result.state === "PAID" &&
          result.paidAt === local.paidAt &&
          result.payment.status === "SUCCEEDED",
        "return_changed_paid_effect",
      );
    }
    await waitFor(
      () =>
        count(
          system.files.paybridge,
          "SELECT count(*) AS count FROM webhook_outbox WHERE status='DELIVERED'",
        ),
      (value) => value === 11,
      "final_delivery_timeout",
    );
    await waitFor(
      () =>
        count(
          system.files.merchant,
          "SELECT count(*) AS count FROM webhook_inbox WHERE status='PROCESSED'",
        ),
      (value) => value === 11,
      "final_processing_timeout",
    );
    const results = [];
    for (const order of orders) {
      const replay = await post({
        origin: system.merchant,
        path: `${order.path}/payment`,
      });
      requireDemo(
        replay.status === 201 && (await replay.text()) === order.creationBytes,
        "changed_state_creation_replay_changed",
      );
      const local = await readOrder(system.merchant, order);
      requireDemo(
        local.paymentIntentId === order.payment.id,
        "order_binding_changed",
      );
      results.push({
        merchant: order.merchant,
        orderId: order.order.id,
        paymentId: order.payment.id,
        state: local.state,
        status: (await snapshot(order)).status,
      });
    }
    signal.throwIfAborted();
    await system.checkpoint("completed");
    return {
      orders: results,
      deliveredEvents: 11,
      unresolvedCases: 1,
      observedInboxBeforeReturn: true,
      deliveryPreservedFinancialFingerprint: financial,
    };
  } finally {
    await system.close();
  }
}
