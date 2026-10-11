import { type } from "arktype";

export function serviceOrigin(value: unknown) {
  const input = type("string > 0").assert(value);
  const url = URL.parse(input);
  if (!url || url.origin !== input || url.username || url.password)
    throw new Error(
      "Service configuration requires an absolute origin without a path or credentials",
    );
  if (url.protocol === "https:") return url.origin;
  if (
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    return url.origin;
  throw new Error("HTTP service origins must be local loopback fixtures");
}
