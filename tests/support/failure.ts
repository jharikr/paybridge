export function sensitiveFailure() {
  const inner = Object.assign(
    new ReferenceError("token=sensitive-capability"),
    {
      name: "sensitive-error-name",
      code: "credential=sensitive-error-code",
    },
  );
  const storage = Object.assign(new Error("credential=sensitive-secret"), {
    code: "SQLITE_BUSY",
    cause: inner,
  });
  return new TypeError("<SOAP>sensitive-provider-payload</SOAP>", {
    cause: storage,
  });
}
