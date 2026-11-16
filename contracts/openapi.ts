import type { FastifyInstance } from "fastify";

export function registerOpenApi(app: FastifyInstance) {
  app.get(
    "/openapi.json",
    {
      schema: {
        description:
          "Generated contract for this local synthetic application. No interactive documentation UI is installed.",
        response: {
          200: {
            type: "object",
            required: ["openapi", "info", "paths"],
            additionalProperties: true,
            properties: {
              openapi: { type: "string", const: "3.1.0" },
              info: {
                type: "object",
                required: ["title", "version"],
                additionalProperties: true,
                properties: {
                  title: { type: "string" },
                  version: { type: "string" },
                },
              },
              paths: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  additionalProperties: true,
                },
              },
            },
            headers: {
              "cache-control": { type: "string", const: "no-store" },
              "x-content-type-options": { type: "string", const: "nosniff" },
            },
          },
        },
      },
    },
    (_request, reply) =>
      reply
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .send(app.swagger()),
  );
}
