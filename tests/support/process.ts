import { spawn } from "node:child_process";

export function startNodeProcess({
  entrypoint,
  args = [],
}: {
  entrypoint: string;
  args?: string[];
}) {
  const child = spawn(process.execPath, [entrypoint, ...args], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  child.stdin?.end();
  const messages: unknown[] = [];
  let output = "";
  let receive: ((message: unknown) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  let ended = false;
  let exitDescription = "";
  child.stdout?.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr?.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.on("message", (message: unknown) => {
    if (receive) receive(message);
    else messages.push(message);
  });
  const exit = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      ended = true;
      exitDescription = `Process exited: ${code ?? signal}\n${output}`;
      reject?.(new Error(exitDescription));
      resolve();
    });
    child.once("error", (error) => {
      ended = true;
      exitDescription = error.message;
      reject?.(error);
      resolve();
    });
  });

  return {
    child,
    output: () => output,
    async message(): Promise<unknown> {
      if (messages.length > 0) return messages.shift();
      if (ended) throw new Error(exitDescription);
      if (receive)
        throw new Error("Only one process message reader may wait at a time");
      return new Promise((resolve, rejectMessage) => {
        const timeout = setTimeout(
          () => finish(new Error(`Process signal timed out\n${output}`)),
          10_000,
        );
        const finish = (error?: Error, value?: unknown) => {
          clearTimeout(timeout);
          receive = undefined;
          reject = undefined;
          if (error) rejectMessage(error);
          else resolve(value);
        };
        receive = (value) => finish(undefined, value);
        reject = (error) => finish(error);
      });
    },
    async stop() {
      if (!ended) child.kill("SIGKILL");
      await exit;
    },
  };
}
