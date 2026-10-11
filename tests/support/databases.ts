import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function isolatedDatabases() {
  const directory = await mkdtemp(join(tmpdir(), "paybridge-test-"));
  return {
    directory,
    paybridge: join(directory, "paybridge.db"),
    merchant: join(directory, "merchant.db"),
    mockFourcs: join(directory, "mock-fourcs.db"),
    async [Symbol.asyncDispose]() {
      await rm(directory, { recursive: true });
    },
  };
}
