import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type } from "arktype";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export async function implementationFingerprint() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const paths = ["package.json", "bun.lock", "tsconfig.json"];
  for (const directory of ["apps", "contracts", "scripts", "tests"]) {
    const entries = await readdir(join(root, directory), {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isFile())
        paths.push(join(entry.parentPath, entry.name).slice(root.length));
    }
  }
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    hash
      .update(path)
      .update("\0")
      .update(await readFile(join(root, path)))
      .update("\0");
  }
  return hash.digest("hex");
}

export function inspect(
  path: string,
  sql: string,
  params: SQLInputValue[] = [],
): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

export function count(path: string, sql: string) {
  return type({ count: "number.integer" }).assert(inspect(path, sql)[0]).count;
}

export function financialFingerprint(files: {
  paybridge: string;
  mock: string;
}) {
  const facts = {
    intents: inspect(
      files.paybridge,
      "SELECT * FROM payment_intents ORDER BY id",
    ),
    attempts: inspect(
      files.paybridge,
      "SELECT * FROM payment_attempts ORDER BY id",
    ),
    events: inspect(
      files.paybridge,
      "SELECT * FROM payment_events ORDER BY id",
    ),
    ledger: inspect(files.mock, "SELECT * FROM mock_transactions ORDER BY id"),
  };
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}
