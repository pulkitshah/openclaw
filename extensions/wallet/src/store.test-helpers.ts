import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { WalletStore } from "./store.js";

export const workerModuleUrl = new URL("./store.worker.ts", import.meta.url);
const opened: Array<{ store: WalletStore; directory?: string }> = [];

afterEach(async () => {
  // Newest first, so a reopened store closes before its directory is removed.
  for (const { store, directory } of opened.splice(0).toReversed()) {
    await store.close();
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

/** A real wallet database in a fresh temp state dir, closed and removed after each test. */
export async function openTestStore(): Promise<WalletStore> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-store-"));
  const store = await WalletStore.open({ stateDir: directory, workerModuleUrl });
  opened.push({ store, directory });
  return store;
}

/** Opens another store on the same database file, closed after the test. */
export async function reopenTestStore(dbPath: string): Promise<WalletStore> {
  const store = await WalletStore.open({ dbPath, workerModuleUrl });
  opened.push({ store });
  return store;
}

export const testDbPath = (store: WalletStore): string => {
  const entry = opened.find((item) => item.store === store);
  if (!entry?.directory) {
    throw new Error("store was not opened by openTestStore");
  }
  return path.join(entry.directory, "plugins", "wallet", "wallet.sqlite");
};
