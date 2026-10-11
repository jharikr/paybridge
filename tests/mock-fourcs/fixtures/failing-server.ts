import { type } from "arktype";
import { createMockFourcs } from "../../../apps/mock-fourcs/server.ts";

const databasePath = type("string > 0").assert(process.argv[2]);
const app = await createMockFourcs({
  databasePath,
  checkpoint: async ({ kind }) => {
    if (kind === "after-acceptance")
      throw new Error("Injected response failure");
  },
});
const url = await app.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ kind: "ready", url });
