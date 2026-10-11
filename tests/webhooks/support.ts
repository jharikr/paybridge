import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { startNodeProcess } from "../support/process.ts";
export const eventId = "evt_11111111111111111111111111111111";
export const payload =
  '{ "id":"evt_11111111111111111111111111111111", "type":"payment.succeeded", "createdAt":"2026-10-11T12:00:01Z", "data":{"paymentIntentId":"pi_22222222222222222222222222222222","merchantReference":"Café 😀","amount":7500,"currency":"XCD","status":"SUCCEEDED","revision":3}}\n';
export const epoch = Date.parse("2026-10-11T12:00:01Z");
export const ready = type({ kind: "'ready'", url: "string" });
export function signed(
  body: string | Uint8Array,
  {
    secret = "mock-webhook-secret-a",
    timestamp = String(Math.floor(epoch / 1000)),
    id = eventId,
  } = {},
) {
  return {
    "content-type": "application/json",
    "paybridge-event-id": id,
    "paybridge-timestamp": timestamp,
    "paybridge-signature": `v1=${createHmac("sha256", secret)
      .update(timestamp + ".")
      .update(body)
      .digest("hex")}`,
  };
}
export async function receiver(path: string, fault = "none", tolerance = 300) {
  const process = startNodeProcess({
    entrypoint: fileURLToPath(
      new URL("./fixtures/receiver.ts", import.meta.url),
    ),
    args: [path, fault, String(epoch), String(tolerance)],
  });
  try {
    return { ...process, url: ready.assert(await process.message()).url };
  } catch (error) {
    await process.stop();
    throw error;
  }
}
