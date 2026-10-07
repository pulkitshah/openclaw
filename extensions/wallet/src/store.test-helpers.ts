import { WalletStore } from "./store.js";

export function memoryKeyed<T>() {
  const m = new Map<string, T>();
  return {
    register: async (k: string, v: T) => {
      m.set(k, v);
    },
    registerIfAbsent: async (k: string, v: T) => (m.has(k) ? false : (m.set(k, v), true)),
    update: async (k: string, fn: (c: T | undefined) => T | undefined) => {
      const n = fn(m.get(k));
      if (n === undefined) {
        m.delete(k);
      } else {
        m.set(k, n);
      }
      return n;
    },
    lookup: async (k: string) => m.get(k),
    entries: async () => [...m].map(([key, value]) => ({ key, value })),
    delete: async (k: string) => m.delete(k),
    clear: async () => m.clear(),
  };
}

export function memoryStore() {
  return new WalletStore({
    entries: memoryKeyed(),
    state: memoryKeyed(),
    backfill: memoryKeyed(),
  });
}
