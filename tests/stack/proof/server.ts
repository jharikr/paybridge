import { type } from "arktype";
import { createHttpApp, errorResponse } from "../../../contracts/http.ts";
import { openProofDatabase, writeProofRecord } from "./database.ts";

const path = type("string > 0").assert(process.argv[2]);
const db = await openProofDatabase({ path });
const { app, requestSchema } = await createHttpApp({
  title: "Local stack compatibility proof",
});
const params = type({
  id: type("0 < string <= 32").describe(
    "Runtime length is 1 to 32 UTF-16 code units. JSON Schema length counts Unicode code points.",
  ),
  "+": "reject",
});
const label = type("0 < string <= 80").narrow(
  (value) => value.trim() === value,
);
const body = type({
  label,
  amount: "1 <= number.integer <= 9007199254740991",
  "+": "reject",
});
const headers = type({ "x-proof-key": "'synthetic'" });
const record = type({
  id: "string",
  label: "string",
  amount: "number.integer",
  "+": "reject",
});
const errors = {
  400: errorResponse.toJsonSchema(),
  413: errorResponse.toJsonSchema(),
  414: errorResponse.toJsonSchema(),
  415: errorResponse.toJsonSchema(),
  500: errorResponse.toJsonSchema(),
};

app.post<{ Params: typeof params.infer; Body: typeof body.infer }>(
  "/proof/:id",
  {
    schema: {
      params: requestSchema(params),
      body: requestSchema(body, {
        fallback: {
          predicate: ({ base }) => ({
            ...base,
            description:
              "Runtime rules: the label must contain at most 80 UTF-16 code units and have no leading or trailing whitespace. JSON Schema length counts Unicode code points.",
          }),
        },
      }),
      headers: requestSchema(headers),
      response: { 201: record.toJsonSchema(), ...errors },
    },
  },
  async (request, reply) => {
    await writeProofRecord({
      db,
      record: { id: request.params.id, ...request.body },
    });
    return reply.code(201).send({
      id: request.params.id,
      ...request.body,
      internalOnly: "must not be serialized",
    });
  },
);

app.get<{ Params: typeof params.infer }>(
  "/proof/:id",
  {
    schema: {
      params: requestSchema(params),
      response: {
        200: record.toJsonSchema(),
        404: errorResponse.toJsonSchema(),
        ...errors,
      },
    },
  },
  async (request, reply) => {
    const found = await db.orm.ProofRecord.where({
      id: request.params.id,
    }).first();
    if (found) return found;
    return reply.code(404).send({
      error: {
        code: "record_not_found",
        message: "The proof record was not found.",
        requestId: request.id,
      },
    });
  },
);
app.get("/openapi.json", { schema: { hide: true } }, () => app.swagger());
app.addHook("onClose", () => db.close());

const url = await app.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ kind: "ready", url });
