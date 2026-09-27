import type { Ok } from "./receipt.js";

export const RECEIPT_STORE_CAP = 1000;

// Receipts produced by the paid route, keyed by their sha256 hash, so a buyer can re-read one for
// free. Process-local by design: in-memory, bounded, lost on restart, not shared across replicas.
// The hash is the canonical proof; this is a convenience cache, not a system of record.
export class ReceiptStore<T = Ok> {
  private readonly m = new Map<string, T>();
  constructor(readonly cap = RECEIPT_STORE_CAP) {}

  put(hash: string, value: T): void {
    this.m.delete(hash); // re-put moves the entry to the newest position
    this.m.set(hash, value);
    while (this.m.size > this.cap) {
      const oldest = this.m.keys().next().value as string;
      this.m.delete(oldest);
    }
  }

  get(hash: string): T | undefined {
    return this.m.get(hash);
  }

  size(): number {
    return this.m.size;
  }
}
