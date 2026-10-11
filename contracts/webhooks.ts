import { createHmac, timingSafeEqual } from "node:crypto";
import { type } from "arktype";
import { merchantPaymentSnapshot } from "./merchant.ts";

export const webhookEventId = type(/^evt_[a-f0-9]{32}$/);
const facts = merchantPaymentSnapshot.omit("status");
const envelope = type({
  id: webhookEventId,
  createdAt: type(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
  "+": "reject",
});
export const webhookEvent = envelope
  .merge({
    type: "'payment.succeeded'",
    data: facts.merge({ status: "'SUCCEEDED'", "+": "reject" }),
    "+": "reject",
  })
  .or(
    envelope.merge({
      type: "'payment.failed'",
      data: facts.merge({ status: "'FAILED'", "+": "reject" }),
      "+": "reject",
    }),
  )
  .or(
    envelope.merge({
      type: "'payment.unknown'",
      data: facts.merge({ status: "'UNKNOWN'", "+": "reject" }),
      "+": "reject",
    }),
  )
  .or(
    envelope.merge({
      type: "'payment.cancelled'",
      data: facts.merge({ status: "'CANCELLED'", "+": "reject" }),
      "+": "reject",
    }),
  );
export type WebhookEvent = typeof webhookEvent.infer;
export const webhookBodyLimit = 16_384;
export function signWebhook({
  timestamp,
  body,
  secret,
}: {
  timestamp: string;
  body: string | Uint8Array;
  secret: string;
}) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`;
}
export function authenticateWebhook({
  timestamp,
  signature,
  body,
  secret,
  now,
  toleranceSeconds,
}: {
  timestamp: unknown;
  signature: unknown;
  body: Uint8Array;
  secret: string;
  now: Date;
  toleranceSeconds: number;
}) {
  if (
    typeof timestamp !== "string" ||
    !/^(0|[1-9][0-9]{0,12})$/.test(timestamp) ||
    typeof signature !== "string" ||
    !/^v1=[a-f0-9]{64}$/.test(signature)
  )
    return false;
  const seconds = Number(timestamp);
  if (
    !Number.isSafeInteger(seconds) ||
    Math.abs(Math.floor(now.getTime() / 1000) - seconds) > toleranceSeconds
  )
    return false;
  const expected = signWebhook({ timestamp, body, secret });
  return timingSafeEqual(
    Buffer.from(signature.slice(3), "hex"),
    Buffer.from(expected.slice(3), "hex"),
  );
}
