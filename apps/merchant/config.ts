import { merchantFixture } from "../../contracts/merchant.ts";
import type { MerchantFixture } from "../../contracts/merchant.ts";

const credentials = {
  "merchant-a": "mock-paybridge-key-a",
  "merchant-b": "mock-paybridge-key-b",
} satisfies Record<MerchantFixture, string>;

export function merchantContext(value: unknown) {
  const parsed = merchantFixture(value);
  if (!merchantFixture.allows(parsed)) return null;
  return { id: parsed, credential: credentials[parsed] };
}
export type MerchantContext = NonNullable<ReturnType<typeof merchantContext>>;
