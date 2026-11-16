import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { type } from "arktype";
import { setTimeout as delay } from "node:timers/promises";

export class DemoFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export function requireDemo<T>({
  condition,
  code,
}: {
  condition: T;
  code: string;
}) {
  if (!condition) throw new DemoFailure(code);
  return condition;
}

export async function waitFor<T>({
  read,
  accepts,
  code,
}: {
  read: () => Promise<T> | T;
  accepts: (value: T) => boolean;
  code: string;
}) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await delay(25);
  }
  throw new DemoFailure(code);
}

export async function reservePort(port = 0) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new DemoFailure("port_unavailable")));
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = type({ port: "number.integer" }).assert(server.address());
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function ownedProcess({
  entrypoint,
  args,
  env,
  capture = false,
}: {
  entrypoint: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  capture?: boolean;
}) {
  const child = spawn(process.execPath, [entrypoint, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "ignore", "ipc"],
  });
  let output = "";
  let overLimit = false;
  child.stdout?.on("data", (data: Buffer) => {
    if (!capture || overLimit) return;
    if (Buffer.byteLength(output) + data.length > 65_536) {
      overLimit = true;
      child.kill("SIGKILL");
    } else output += data.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DemoFailure("process_ready_timeout")),
      10_000,
    );
    child.once("message", (message: unknown) => {
      clearTimeout(timer);
      if (type({ kind: "'ready'" }).allows(message)) resolve();
      else reject(new DemoFailure("invalid_process_readiness"));
    });
    void exited.then(() => {
      clearTimeout(timer);
      reject(new DemoFailure("process_exited_before_ready"));
    });
  });
  // Command processes exit without an IPC readiness message.
  void ready.catch(() => undefined);
  return {
    pid: child.pid,
    ready,
    async result() {
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const code = await exited;
        if (overLimit) throw new DemoFailure("command_output_too_large");
        const value: unknown = JSON.parse(output);
        return { code, value };
      } finally {
        clearTimeout(timer);
      }
    },
    async stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null)
        child.kill(signal);
      const timer = setTimeout(() => child.kill("SIGKILL"), 7000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
