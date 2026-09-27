import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { PAYMENT_SIGNATURE_HEADERS, PAYMENT_RESPONSE_HEADERS } from "./x402-headers.js";

export type AppEnv = { Variables: { receiptHash?: string } };

export type FunnelCounters = {
  requests: number; issued402: number; presented: number; served: number; failed: number; uniquePayers: number;
};

type Event = "402_issued" | "payment_presented" | "served" | "payment_failed";

// Funnel state for the paid route. Payer addresses are reduced to a sha256 in memory, only their
// count leaves this class, and no log line ever carries one.
export class Funnel {
  private readonly c = { requests: 0, issued402: 0, presented: 0, served: 0, failed: 0 };
  private readonly payers = new Set<string>();
  constructor(private readonly log: (line: string) => void = (l) => console.log(l)) {}

  emit(ev: Event, fields: Record<string, string | number | boolean>): void {
    this.log(JSON.stringify({ ts: new Date().toISOString(), ev, ...fields }));
  }

  request(): void { this.c.requests++; }
  issued402(path: string, txid: boolean): void { this.c.issued402++; this.emit("402_issued", { path, txid }); }
  presented(path: string): void { this.c.presented++; this.emit("payment_presented", { path, header: true }); }
  failed(path: string, status: number): void { this.c.failed++; this.emit("payment_failed", { path, status }); }
  served(path: string, hash: string, payer: string | undefined): void {
    this.c.served++;
    if (payer) this.payers.add(createHash("sha256").update(payer).digest("hex"));
    this.emit("served", { path, status: 200, hash });
  }

  counters(): FunnelCounters {
    return { ...this.c, uniquePayers: this.payers.size };
  }
}

function payerFrom(headerValue: string | null): string | undefined {
  if (!headerValue) return undefined;
  try { return decodePaymentResponseHeader(headerValue).payer; } catch { return undefined; }
}

/** Wraps the paid route (register before paymentMiddleware so it sees the final response). */
export function funnel(f: Funnel): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    f.request();
    const path = c.req.path;
    const hasPayment = PAYMENT_SIGNATURE_HEADERS.some((h) => c.req.header(h));
    if (hasPayment) f.presented(path);
    await next();
    const status = c.res.status;
    if (!hasPayment) {
      if (status === 402) f.issued402(path, Boolean(c.req.query("txid")));
      return;
    }
    if (status === 200) {
      const settle = PAYMENT_RESPONSE_HEADERS.map((h) => c.res.headers.get(h)).find(Boolean) ?? null;
      f.served(path, c.get("receiptHash") ?? "", payerFrom(settle));
    } else {
      f.failed(path, status);
    }
  };
}
