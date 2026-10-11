import { expect, test } from "vitest";
import { type } from "arktype";
import { isolatedDatabases } from "../support/databases.ts";
import { journey } from "../provider/support.ts";
import { launchMerchant } from "../merchant/support.ts";
import { contractAt, compareResponse } from "./support.ts";

test("each application serves its generated document with an explicit JSON response contract and no implicit HEAD", async () => {
  await using files = await isolatedDatabases();
  await using services = await journey(files);
  const merchant = await launchMerchant({
    path: files.merchant,
    paybridgeUrl: services.url,
  });
  try {
    for (const origin of [services.url, merchant.url, services.mockUrl]) {
      const contract = await contractAt(origin);
      await compareResponse({
        contract,
        path: "/openapi.json",
        method: "get",
        response: await fetch(`${origin}/openapi.json`),
        status: 200,
      });
      expect(
        (await fetch(`${origin}/openapi.json`, { method: "HEAD" })).status,
      ).toBe(404);
      for (const methods of Object.values(contract.paths))
        expect(methods).not.toHaveProperty("head");
      for (const [path, methods] of Object.entries(contract.paths)) {
        for (const endpoint of Object.values(methods)) {
          const parameters =
            type({
              "parameters?": type({ in: "string", name: "string" }).array(),
            }).assert(endpoint).parameters ?? [];
          const names = parameters
            .filter((parameter) => parameter.in === "query")
            .map((parameter) => parameter.name);
          expect(names, `Unexpected query parameters on ${path}`).toEqual(
            path === "/{merchantFixture}/payment-return" ? ["paymentId"] : [],
          );
        }
      }
    }
  } finally {
    await merchant.stop();
  }
});
