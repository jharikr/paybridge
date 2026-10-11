import { request } from "node:http";
import { type } from "arktype";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect } from "vitest";

const document = type({
  openapi: "'3.1.0'",
  paths: { "[string]": { "[string]": "unknown" } },
});
const operation = type({ responses: { "[string]": "unknown" } });
const responseDefinition = type({
  "headers?": { "[string]": { schema: "object" } },
  "content?": { "[string]": { schema: "object" } },
});

export async function contractAt(origin: string) {
  const response = await fetch(`${origin}/openapi.json`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(
    "application/json; charset=utf-8",
  );
  return document.assert(await response.json());
}

export function compareParameters({
  contract,
  path,
  method,
  values,
}: {
  contract: typeof document.infer;
  path: string;
  method: string;
  values: Record<string, string>;
}) {
  const parameters = type({
    parameters: type({
      name: "string",
      in: "string",
      "required?": "boolean",
      schema: "object",
    }).array(),
  }).assert(contract.paths[path]?.[method]).parameters;
  const ajv = new Ajv2020({ strict: false });
  for (const [name, value] of Object.entries(values)) {
    const parameter = parameters.find((item) => item.name === name);
    if (!parameter)
      throw new Error(`Missing ${name} parameter on ${method} ${path}`);
    expect(parameter.required).toBe(true);
    const validates = ajv.compile(parameter.schema);
    expect(validates(value)).toBe(true);
    if (name !== "merchantFixture") expect(validates("")).toBe(false);
  }
}

export async function compareResponse({
  contract,
  path,
  method,
  response,
  status,
  headers = ["cache-control", "x-content-type-options"],
}: {
  contract: typeof document.infer;
  path: string;
  method: string;
  response: Response;
  status: number;
  headers?: string[];
}) {
  expect(response.status).toBe(status);
  const endpoint = operation.assert(contract.paths[path]?.[method]);
  expect(
    endpoint.responses[String(status)],
    `Missing response contract for ${method} ${path} ${status}`,
  ).toBeDefined();
  const definition = responseDefinition.assert(
    endpoint.responses[String(status)],
  );
  const ajv = new Ajv2020({ strict: false });
  for (const name of headers) {
    const header = type({ schema: "object" }).assert(
      definition.headers?.[name],
    );
    const value = response.headers.get(name);
    expect(
      value,
      `Missing ${name} on ${method} ${path} ${status}`,
    ).not.toBeNull();
    expect(ajv.compile(header.schema)(value)).toBe(true);
  }
  const body = await response.text();
  if (status === 204) {
    expect(definition.content).toBeUndefined();
    expect(body).toBe("");
    return undefined;
  }
  const media = response.headers.get("content-type");
  const contentType = type("string").assert(media).split(";")[0] ?? "";
  if (contentType === "application/json" || contentType === "text/plain")
    expect(media).toBe(`${contentType}; charset=utf-8`);
  const schema = type({ schema: "object" }).assert(
    definition.content?.[contentType],
  ).schema;
  const value: unknown =
    contentType === "application/json" ? JSON.parse(body) : body;
  expect(
    ajv.compile(schema)(value),
    `Invalid response for ${method} ${path} ${status}`,
  ).toBe(true);
  return value;
}

export function rawRequest({
  origin,
  path,
  method = "GET",
  headers = {},
}: {
  origin: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      origin,
      { path, method, headers, signal: AbortSignal.timeout(3000) },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const received = new Headers();
          for (const [name, values] of Object.entries(response.headers)) {
            if (Array.isArray(values))
              for (const value of values) received.append(name, value);
            else if (values !== undefined) received.set(name, values);
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: type("number.integer").assert(response.statusCode),
              headers: received,
            }),
          );
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
