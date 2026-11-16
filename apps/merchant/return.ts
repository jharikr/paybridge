import { type } from "arktype";
import type { createHttpApp } from "../../contracts/http.ts";
import { paymentId } from "../../contracts/payments.ts";
import { merchantReturnResult } from "../../contracts/merchant.ts";
import { merchantContext } from "./config.ts";
import { MerchantError } from "./orders.ts";
import type { MerchantDatabase } from "./database.ts";
import { returnPayment } from "./snapshots.ts";

export function registerMerchantReturn({
  app,
  requestSchema,
  db,
  paybridgeOrigin,
  errors,
  securityHeaders,
  beforeCommit,
}: Awaited<ReturnType<typeof createHttpApp>> & {
  db: MerchantDatabase;
  paybridgeOrigin: string;
  errors: Record<string, unknown>;
  securityHeaders: object;
  beforeCommit?: () => Promise<void>;
}) {
  const params = type({ merchantFixture: "string", "+": "reject" });
  const query = type({ paymentId, "+": "reject" });
  app.get(
    "/:merchantFixture/payment-return",
    {
      schema: {
        params: requestSchema({ validator: params }),
        querystring: requestSchema({ validator: query }),
        response: {
          200: {
            ...merchantReturnResult.toJsonSchema(),
            headers: securityHeaders,
          },
          ...errors,
        },
      },
    },
    async (request) => {
      const merchant = merchantContext(
        params.assert(request.params).merchantFixture,
      );
      if (!merchant)
        throw new MerchantError({ status: 404, code: "payment_not_found" });
      return returnPayment({
        db,
        merchant,
        id: query.assert(request.query).paymentId,
        paybridgeOrigin,
        ...(beforeCommit ? { beforeCommit } : {}),
      });
    },
  );
}
