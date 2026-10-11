import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { type, type Type } from "arktype";
import Fastify from "fastify";
import swagger, { type FastifyDynamicSwaggerOptions } from "@fastify/swagger";

export const errorResponse = type({
  error: {
    code: "string",
    message: "string",
    requestId: "string",
    "+": "reject",
  },
  "+": "reject",
});

const newRequestId = () => `req_${randomUUID()}`;

function invalidRequest({ requestId }: { requestId: string }) {
  return {
    error: {
      code: "invalid_request",
      message: "The request is invalid.",
      requestId,
    },
  };
}

function rejectRouterRequest({
  response,
  statusCode,
}: {
  response: ServerResponse;
  statusCode: 400 | 414;
}) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(invalidRequest({ requestId: newRequestId() })));
}

export async function createHttpApp({
  title,
  openapi,
}: {
  title: string;
  openapi?: FastifyDynamicSwaggerOptions["openapi"];
}) {
  const validators = new Map<string, Type>();
  const schemaIdentity = type({ $id: "string" });
  const app = Fastify({
    exposeHeadRoutes: false,
    bodyLimit: 16_384,
    genReqId: newRequestId,
    routerOptions: {
      maxParamLength: 100,
      onBadUrl: (_path, _request, response) =>
        rejectRouterRequest({ response, statusCode: 400 }),
      onMaxParamLength: (_path, _request, response) =>
        rejectRouterRequest({ response, statusCode: 414 }),
    },
    logger: {
      level: "warn",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.x-checkout-token",
      ],
    },
    disableRequestLogging: true,
  });

  function requestSchema(
    validator: Type,
    options?: Parameters<Type["toJsonSchema"]>[0],
  ) {
    const id = `urn:paybridge:schema:${validators.size}`;
    const source = validator.toJsonSchema(options);
    // Swagger treats an object without properties as legacy parameter shorthand.
    const schema = {
      ...source,
      ...("type" in source &&
      source.type === "object" &&
      !("properties" in source)
        ? { properties: {} }
        : {}),
      $id: id,
    };
    validators.set(id, validator);
    return schema;
  }

  app.setValidatorCompiler(({ schema }) => {
    const validator = validators.get(schemaIdentity.assert(schema).$id);
    if (!validator)
      throw new Error("Request schema is not registered with ArkType");
    return (value: unknown) => {
      const result = validator(value);
      if (result instanceof type.errors)
        return { error: new Error("Invalid request") };
      return { value: result };
    };
  });
  app.setErrorHandler((error, request, reply) => {
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply
        .code(error.statusCode)
        .send(invalidRequest({ requestId: request.id }));
    }
    request.log.error({ requestId: request.id }, "Request failed");
    return reply.code(500).send({
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
        requestId: request.id,
      },
    });
  });
  await app.register(swagger, {
    openapi: {
      ...openapi,
      openapi: "3.1.0",
      info: { title, version: "0.1.0" },
    },
  });
  return { app, requestSchema };
}
