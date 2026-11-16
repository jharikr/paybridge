// Both hostnames reach the same local merchant listener, but are distinct URL origins.
export function fixtureReturnOrigins(origin: string) {
  const first = new URL(origin);
  const second = new URL(origin);
  second.hostname = first.hostname === "localhost" ? "127.0.0.1" : "localhost";
  return { "merchant-a": first.origin, "merchant-b": second.origin };
}
