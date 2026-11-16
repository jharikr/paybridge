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

export async function runJourney({
  directory,
  paybridgePort,
  signal,
}: {
  directory: string;
  paybridgePort: number;
  signal: AbortSignal;
}) {
  const system = await demoSystem({ directory, paybridgePort, signal });
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
    async function leave({
      order,
      status,
    }: {
      order: BoundOrder;
      status: string;
    }) {
      const before = await snapshot(order);
      requireDemo({
        condition: before.status === status,
        code: "leave_state_mismatch",
      });
      const response = await post({
        origin: system.paybridge,
        path: checkoutPath({ order, operation: "leave" }),
      });
      requireDemo({
        condition: response.status === 303 && (await response.text()) === "",
        code: "leave_failed",
      });
      requireDemo({
        condition:
          response.headers.get("location") ===
          `${system.returnOrigins[order.merchant]}/${order.merchant}/payment-return?paymentId=${order.payment.id}`,
        code: "unsafe_return_location",
      });
      requireDemo({
        condition:
          JSON.stringify(await snapshot(order)) === JSON.stringify(before),
        code: "leave_changed_payment",
      });
    }
    async function confirm({
      order,
      method,
      commandNumber,
      revision,
    }: {
      order: BoundOrder;
      method: MockPaymentMethodRef;
      commandNumber: number;
      revision: number;
    }) {
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
    async function accepted({
      order,
      method,
      commandNumber = 1,
      revision = 1,
    }: {
      order: BoundOrder;
      method: MockPaymentMethodRef;
      commandNumber?: number;
      revision?: number;
    }) {
      const response = await confirm({
        order,
        method,
        commandNumber,
        revision,
      });
      requireDemo({
        condition: response.status === 202,
        code: "direct_confirmation_failed",
      });
      const bytes = await response.text();
      confirmationAcknowledgment.assert(JSON.parse(bytes));
      return bytes;
    }
    await leave({ order: direct, status: "PENDING" });
    const directBytes = await accepted({
      order: direct,
      method: "pm_mock_declined",
    });
    await leave({ order: direct, status: "PROCESSING" });
    const display = await get(checkout.payment.checkoutUrl);
    requireDemo({
      condition: display.status === 200,
      code: "checkout_display_failed",
    });
    checkoutDisplay.assert(await display.json());
    const checkoutConfirm = () =>
      post({
        origin: system.paybridge,
        path: checkoutPath({ order: checkout, operation: "confirm" }),
        body: { mockPaymentMethodRef: "pm_mock_approved", expectedRevision: 1 },
        key: "demo-checkout-confirm",
      });
    const redirect = await checkoutConfirm();
    requireDemo({
      condition: redirect.status === 303 && (await redirect.text()) === "",
      code: "checkout_confirmation_failed",
    });
    await accepted({ order: incomplete, method: "pm_mock_incomplete" });
    await accepted({ order: lostSuccess, method: "pm_mock_lost_response" });
    await accepted({
      order: lostFailure,
      method: "pm_mock_decline_lost_response",
    });
    await accepted({ order: absent, method: "pm_mock_fail_before_acceptance" });
    const cancel = () =>
      post({
        origin: system.paybridge,
        path: `/v1/payment-intents/${cancelled.payment.id}/cancel`,
        credential: credential(cancelled.merchant),
      });
    const cancellation = await cancel();
    requireDemo({
      condition: cancellation.status === 200,
      code: "cancellation_failed",
    });
    const cancellationBytes = await cancellation.text();
    requireDemo({
      condition:
        paymentSnapshot.assert(JSON.parse(cancellationBytes)).status ===
        "CANCELLED",
      code: "cancellation_not_terminal",
    });
    requireDemo({
      condition: (await (await cancel()).text()) === cancellationBytes,
      code: "cancellation_replay_changed",
    });
    await leave({ order: cancelled, status: "CANCELLED" });
    requireDemo({
      condition:
        (
          await confirm({
            order: cancelled,
            method: "pm_mock_approved",
            commandNumber: 1,
            revision: 2,
          })
        ).status === 409,
      code: "cancelled_binding_reused",
    });
    for (const order of orders)
      requireDemo({
        condition:
          (await readOrder({ origin: system.merchant, order })).state ===
          "UNPAID",
        code: "acknowledgment_paid_order",
      });
    const stolen = new URL(direct.payment.checkoutUrl);
    stolen.search = new URL(checkout.payment.checkoutUrl).search;
    requireDemo({
      condition: (await get(stolen)).status === 404,
      code: "capability_crossed_binding",
    });
    requireDemo({
      condition:
        (
          await fetch(
            `${system.paybridge}/v1/payment-intents/${direct.payment.id}`,
            {
              headers: { authorization: `Bearer ${credential("merchant-b")}` },
            },
          )
        ).status === 404,
      code: "merchant_isolation_failed",
    });
    requireDemo({
      condition:
        (
          await get(
            `${system.merchant}/merchant-b/payment-return?paymentId=${direct.payment.id}`,
          )
        ).status === 404,
      code: "return_isolation_failed",
    });

    await system.checkpoint("commands-accepted");
    await system.stop({ name: "merchant-api", signal: "SIGKILL" });
    signal.throwIfAborted();
    await system.startWorker();
    await waitFor({
      read: () =>
        count({
          path: system.files.paybridge,
          sql: "SELECT count(*) AS count FROM payment_intents WHERE status IN ('SUCCEEDED','FAILED','UNKNOWN','CANCELLED')",
        }),
      accepts: (value) => value === 7,
      code: "outage_financial_completion_timeout",
    });
    await waitFor({
      read: () =>
        count({
          path: system.files.paybridge,
          sql: "SELECT count(*) AS count FROM webhook_outbox WHERE attempt_count>0",
        }),
      accepts: (value) => value === 7,
      code: "outage_delivery_attempt_timeout",
    });
    requireDemo({
      condition:
        count({
          path: system.files.merchant,
          sql: "SELECT count(*) AS count FROM webhook_inbox",
        }) === 0,
      code: "outage_received_notification",
    });
    const financial = financialFingerprint(system.files);
    await system.checkpoint("receiver-outage-observed");
    await system.stop({ name: "paybridge-worker", signal: "SIGKILL" });
    await system.stop({ name: "mock", signal: "SIGKILL" });
    await system.startMock();
    await system.startMerchant();
    await system.startWorker();
    await system.startInbox();
    await waitFor({
      read: () =>
        count({
          path: system.files.merchant,
          sql: "SELECT count(*) AS count FROM webhook_inbox WHERE status='PROCESSED'",
        }),
      accepts: (value) => value === 7,
      code: "inbox_recovery_timeout",
    });
    requireDemo({
      condition:
        (await readOrder({ origin: system.merchant, order: checkout }))
          .state === "PAID",
      code: "inbox_payment_not_applied",
    });
    await waitFor({
      read: () =>
        count({
          path: system.files.paybridge,
          sql: "SELECT count(*) AS count FROM webhook_outbox WHERE status='DELIVERED'",
        }),
      accepts: (value) => value === 7,
      code: "delivery_completion_timeout",
    });
    requireDemo({
      condition: financialFingerprint(system.files) === financial,
      code: "delivery_changed_financial_facts",
    });
    await system.checkpoint("delivery-recovered");
    signal.throwIfAborted();
    await leave({ order: direct, status: "FAILED" });
    await leave({ order: absent, status: "UNKNOWN" });
    await leave({ order: checkout, status: "SUCCEEDED" });
    requireDemo({
      condition:
        (await snapshot(incomplete)).latestAttempt?.failureCode ===
        "Incomplete",
      code: "incomplete_classification_changed",
    });
    const directReplay = await confirm({
      order: direct,
      method: "pm_mock_declined",
      commandNumber: 1,
      revision: 1,
    });
    requireDemo({
      condition:
        directReplay.status === 202 &&
        (await directReplay.text()) === directBytes,
      code: "confirmation_replay_changed",
    });
    const checkoutReplay = await checkoutConfirm();
    requireDemo({
      condition:
        checkoutReplay.status === 303 &&
        checkoutReplay.headers.get("location") ===
          redirect.headers.get("location") &&
        (await checkoutReplay.text()) === "",
      code: "checkout_replay_changed",
    });
    requireDemo({
      condition:
        (
          await confirm({
            order: direct,
            method: "pm_mock_approved",
            commandNumber: 2,
            revision: 1,
          })
        ).status === 409,
      code: "stale_confirmation_accepted",
    });
    await accepted({
      order: direct,
      method: "pm_mock_approved",
      commandNumber: 3,
      revision: (await snapshot(direct)).revision,
    });
    requireDemo({
      condition:
        (
          await confirm({
            order: absent,
            method: "pm_mock_approved",
            commandNumber: 2,
            revision: (await snapshot(absent)).revision,
          })
        ).status === 409,
      code: "unknown_retry_accepted",
    });
    const operator = await operatorCommands({ directory, files: system.files });
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
    await accepted({
      order: lostFailure,
      method: "pm_mock_approved",
      commandNumber: 2,
      revision: (await snapshot(lostFailure)).revision,
    });
    await operator.resolve({
      id: absent.payment.id,
      name: "absent",
      resolution: "ABSENT",
    });
    requireDemo({
      condition: (await snapshot(absent)).status === "UNKNOWN",
      code: "absent_evidence_changed_state",
    });
    await system.checkpoint("reconciled-with-one-unknown");
    const paidOrders = [direct, checkout, lostSuccess, lostFailure];
    for (const order of paidOrders) {
      signal.throwIfAborted();
      const local = await waitFor({
        read: () => readOrder({ origin: system.merchant, order }),
        accepts: (value) => value.state === "PAID",
        code: "inbox_payment_timeout",
      });
      const returning = await get(
        `${system.returnOrigins[order.merchant]}/${order.merchant}/payment-return?paymentId=${order.payment.id}`,
      );
      requireDemo({
        condition: returning.status === 200,
        code: "return_failed",
      });
      const result = merchantReturnResult.assert(await returning.json());
      requireDemo({
        condition:
          result.state === "PAID" &&
          result.paidAt === local.paidAt &&
          result.payment.status === "SUCCEEDED",
        code: "return_changed_paid_effect",
      });
    }
    await waitFor({
      read: () =>
        count({
          path: system.files.paybridge,
          sql: "SELECT count(*) AS count FROM webhook_outbox WHERE status='DELIVERED'",
        }),
      accepts: (value) => value === 11,
      code: "final_delivery_timeout",
    });
    await waitFor({
      read: () =>
        count({
          path: system.files.merchant,
          sql: "SELECT count(*) AS count FROM webhook_inbox WHERE status='PROCESSED'",
        }),
      accepts: (value) => value === 11,
      code: "final_processing_timeout",
    });
    const results = [];
    for (const order of orders) {
      const replay = await post({
        origin: system.merchant,
        path: `${order.path}/payment`,
      });
      requireDemo({
        condition:
          replay.status === 201 &&
          (await replay.text()) === order.creationBytes,
        code: "changed_state_creation_replay_changed",
      });
      const local = await readOrder({ origin: system.merchant, order });
      requireDemo({
        condition: local.paymentIntentId === order.payment.id,
        code: "order_binding_changed",
      });
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
