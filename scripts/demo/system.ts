import { writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { type } from "arktype";
import { ownedProcess, reservePort } from "./process.ts";

type ProcessName =
  | "mock"
  | "paybridge-api"
  | "merchant-api"
  | "paybridge-worker"
  | "inbox-worker";

export async function demoSystem(
  directory: string,
  paybridgePort: number,
  signal: AbortSignal,
) {
  const processes = new Map<ProcessName, ReturnType<typeof ownedProcess>>();
  const reservations: Awaited<ReturnType<typeof reservePort>>[] = [];
  const history: {
    kind: "started" | "stopped";
    name: ProcessName;
    pid: number;
    at: string;
  }[] = [];
  const origins: Record<string, string> = {};
  let stage = "setup";
  const files = {
    paybridge: join(directory, "paybridge.db"),
    merchant: join(directory, "merchant.db"),
    mock: join(directory, "mock-fourcs.db"),
  };
  const persist = async () => {
    await writeFile(
      join(directory, "manifest-next.json"),
      JSON.stringify({ stage, origins, files, processes: history }, null, 2) +
        "\n",
      { mode: 0o600 },
    );
    await rename(
      join(directory, "manifest-next.json"),
      join(directory, "manifest.json"),
    );
  };
  async function checkpoint(value: string) {
    stage = value;
    await persist();
  }
  async function stop(
    name: ProcessName,
    signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
  ) {
    const process = processes.get(name);
    if (!process) return;
    await process.stop(signal);
    history.push({
      kind: "stopped",
      name,
      pid: type("number.integer").assert(process.pid),
      at: new Date().toISOString(),
    });
    processes.delete(name);
  }
  async function close() {
    for (const name of [...processes.keys()].reverse()) await stop(name);
    for (const reservation of reservations) await reservation.close();
    await persist();
  }
  async function stopAndRecord(
    name: ProcessName,
    signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
  ) {
    await stop(name, signal);
    await persist();
  }
  async function reserve(port = 0) {
    const reservation = await reservePort(port);
    reservations.push(reservation);
    return reservation;
  }
  try {
    await persist();
    const paybridge = await reserve(paybridgePort);
    const merchant = await reserve();
    const mock = await reserve();
    Object.assign(origins, {
      paybridge: paybridge.origin,
      merchant: merchant.origin,
      mock: mock.origin,
    });
    await persist();
    const env = {
      MERCHANT_ORIGIN: merchant.origin,
      PAYBRIDGE_ORIGIN: paybridge.origin,
    };
    async function launch(name: ProcessName, entry: string, args: string[]) {
      signal.throwIfAborted();
      const process = ownedProcess({
        entrypoint: fileURLToPath(
          new URL(`../../apps/${entry}`, import.meta.url),
        ),
        args,
        env,
      });
      processes.set(name, process);
      history.push({
        kind: "started",
        name,
        pid: type("number.integer").assert(process.pid),
        at: new Date().toISOString(),
      });
      await persist();
      await process.ready;
      signal.throwIfAborted();
    }
    const startMock = () =>
      launch("mock", "mock-fourcs/main.ts", [files.mock, String(mock.port)]);
    const startMerchant = () =>
      launch("merchant-api", "merchant/server.ts", [
        files.merchant,
        String(merchant.port),
        paybridge.origin,
        merchant.origin,
      ]);
    const startWorker = () =>
      launch("paybridge-worker", "paybridge/worker.ts", [
        files.paybridge,
        mock.origin,
        "1000",
        "5000",
        "25",
        "100",
        "500",
      ]);
    const startInbox = () =>
      launch("inbox-worker", "merchant/worker.ts", [
        files.merchant,
        "5000",
        "25",
        "100",
        "500",
      ]);
    await mock.close();
    await startMock();
    await paybridge.close();
    await launch("paybridge-api", "paybridge/server.ts", [
      files.paybridge,
      String(paybridge.port),
    ]);
    await merchant.close();
    await startMerchant();
    return {
      files,
      paybridge: paybridge.origin,
      merchant: merchant.origin,
      mock: mock.origin,
      startWorker,
      startInbox,
      startMerchant,
      startMock,
      stop: stopAndRecord,
      close,
      checkpoint,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
