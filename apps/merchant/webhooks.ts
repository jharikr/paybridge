import { createHash } from "node:crypto";
import { MIMEType } from "node:util";
import { type } from "arktype";
import type { FastifyRequest } from "fastify";
import { errorResponse, type createHttpApp } from "../../contracts/http.ts";
import {
  authenticateWebhook,
  webhookBodyLimit,
  webhookEvent,
  webhookEventId,
} from "../../contracts/webhooks.ts";
import { merchantContext, webhookSecret } from "./config.ts";
import type { MerchantDatabase } from "./database.ts";

export type ReceiptCheckpoint = (event: {
  kind: "before-receipt-commit" | "after-receipt-commit";
  eventId: string;
}) => Promise<void>;
class ReceiptError extends Error {
  readonly statusCode: 400 | 401 | 409 | 415;
  readonly code: string;
  constructor({
    statusCode,
    code,
  }: {
    statusCode: 400 | 401 | 409 | 415;
    code: string;
  }) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}
export async function registerWebhooks({
  app,
  requestSchema,
  db,
  now = () => new Date(),
  toleranceSeconds = 300,
  checkpoint,
}: {
  app: Awaited<ReturnType<typeof createHttpApp>>["app"];
  requestSchema: Awaited<ReturnType<typeof createHttpApp>>["requestSchema"];
  db: MerchantDatabase;
  now?: () => Date;
  toleranceSeconds?: number;
  checkpoint?: ReceiptCheckpoint;
}) {
  type("0 <= number.integer <= 3600").assert(toleranceSeconds);
  await app.register(async (receiver) => {
    const rawBodies = new WeakMap<FastifyRequest, string>();
    const params = type({ merchantFixture: "string" });
    const fallback = receiver.errorHandler;
    receiver.setErrorHandler((error, request, reply) => {
      if (!(error instanceof ReceiptError))
        return fallback.call(receiver, error, request, reply);
      if (error.statusCode === 409)
        request.log.warn(
          { code: error.code, requestId: request.id },
          "Webhook receipt conflict",
        );
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: "The webhook receipt was rejected.",
          requestId: request.id,
        },
      });
    });
    receiver.removeAllContentTypeParsers();
    receiver.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: webhookBodyLimit },
      (request, body, done) => {
        try {
          let media: MIMEType;
          try {
            media = new MIMEType(
              String(request.headers["content-type"]).replace(
                /(;[ \t]*charset)[ \t]*=[ \t]*/gi,
                "$1=",
              ),
            );
          } catch {
            throw new ReceiptError({
              statusCode: 415,
              code: "invalid_webhook_media_type",
            });
          }
          if (
            (media.params.get("charset") ?? "utf-8").toLowerCase() !== "utf-8"
          )
            throw new ReceiptError({
              statusCode: 415,
              code: "invalid_webhook_media_type",
            });
          const merchant = merchantContext(
            params.assert(request.params).merchantFixture,
          );
          if (
            !merchant ||
            !Buffer.isBuffer(body) ||
            !authenticateWebhook({
              timestamp: request.headers["paybridge-timestamp"],
              signature: request.headers["paybridge-signature"],
              body,
              secret: webhookSecret(merchant.id),
              now: now(),
              toleranceSeconds,
            })
          )
            throw new ReceiptError({
              statusCode: 401,
              code: "invalid_webhook_authentication",
            });
          let raw: string;
          let value: unknown;
          try {
            raw = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(body);
            value = JSON.parse(raw);
          } catch {
            throw new ReceiptError({
              statusCode: 400,
              code: "invalid_webhook_event",
            });
          }
          const event = webhookEvent(value);
          if (
            event instanceof type.errors ||
            !Number.isFinite(Date.parse(event.createdAt)) ||
            new Date(event.createdAt).toISOString() !==
              (event.createdAt.length === 20
                ? event.createdAt.replace("Z", ".000Z")
                : event.createdAt) ||
            request.headers["paybridge-event-id"] !== event.id
          )
            throw new ReceiptError({
              statusCode: 400,
              code: "invalid_webhook_event",
            });
          rawBodies.set(request, raw);
          done(null, event);
        } catch (error) {
          done(
            error instanceof Error
              ? error
              : new Error("Webhook parsing failed"),
          );
        }
      },
    );
    receiver.post(
      "/api/webhooks/paybridge/:merchantFixture",
      {
        schema: {
          params: requestSchema({ validator: params }),
          body: requestSchema({
            validator: webhookEvent.describe(
              "Signed JSON event. Authenticate the exact raw UTF-8 bytes before parsing; whitespace is significant. Maximum 16,384 bytes. createdAt must be a valid UTC calendar timestamp with seconds or exactly three fractional digits. Conflicting duplicate identity fields are invalid.",
            ),
          }),
          headers: requestSchema({
            validator: type({
              "paybridge-event-id": webhookEventId,
              "paybridge-timestamp": type(/^(0|[1-9][0-9]{0,12})$/).describe(
                "Unix seconds, within the configured tolerance in both directions. Default 300 seconds.",
              ),
              "paybridge-signature": type(/^v1=[a-f0-9]{64}$/).describe(
                "HMAC-SHA256 of timestamp, a period, and exact body bytes, using this destination merchant's secret.",
              ),
            }),
          }),
          querystring: requestSchema({ validator: type({ "+": "reject" }) }),
          response: {
            204: {
              type: "null",
              description:
                "Authenticated receipt committed; order processing remains pending.",
              headers: {
                "cache-control": { type: "string", const: "no-store" },
                "x-content-type-options": { type: "string", const: "nosniff" },
              },
            },
            ...Object.fromEntries(
              [400, 401, 409, 413, 414, 415, 500, 503].map((status) => [
                status,
                {
                  ...errorResponse.toJsonSchema(),
                  headers: {
                    "cache-control": { type: "string", const: "no-store" },
                    "x-content-type-options": {
                      type: "string",
                      const: "nosniff",
                    },
                    ...(status === 503
                      ? { "retry-after": { type: "string", const: "1" } }
                      : {}),
                  },
                },
              ]),
            ),
          },
        },
      },
      async (request, reply) => {
        const merchant = merchantContext(
          params.assert(request.params).merchantFixture,
        );
        const event = webhookEvent.assert(request.body);
        const payload = rawBodies.get(request);
        if (!merchant || payload === undefined)
          throw new Error("Verified webhook bytes are missing");
        const at = now().toISOString();
        await db.transaction(async (tx) => {
          // SQLite reads the first duplicate JSON key; reject disagreement with the validated event.
          await tx.execute(
            db.raw.sql`
          INSERT INTO webhook_inbox (event_id,receiving_merchant_id,payment_intent_id,event_type,revision,payload,payload_hash,status,attempt_count,next_attempt_at,received_at)
          SELECT ${event.id},${merchant.id},${event.data.paymentIntentId},${event.type},${event.data.revision},${payload},${createHash("sha256").update(payload).digest("hex")},'PENDING',0,${at},${at}
          WHERE json_extract(${payload},'$.id') IS ${event.id} AND json_extract(${payload},'$.data.paymentIntentId') IS ${event.data.paymentIntentId} AND json_extract(${payload},'$.type') IS ${event.type} AND json_extract(${payload},'$.data.revision') IS ${event.data.revision}
          ON CONFLICT(event_id) DO NOTHING
        `
              .affectedCount()
              .build(),
          );
          const stored = await tx.orm.WebhookInbox.where({
            eventId: event.id,
          }).first();
          if (!stored)
            throw new ReceiptError({
              statusCode: 400,
              code: "invalid_webhook_event",
            });
          if (
            stored.receivingMerchantId !== merchant.id ||
            stored.payload !== payload
          )
            throw new ReceiptError({
              statusCode: 409,
              code: "webhook_identity_conflict",
            });
          await checkpoint?.({
            kind: "before-receipt-commit",
            eventId: event.id,
          });
        });
        await checkpoint?.({ kind: "after-receipt-commit", eventId: event.id });
        return reply.code(204).send();
      },
    );
  });
}
