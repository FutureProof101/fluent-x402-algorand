import { x402HTTPClient } from "@x402/core/client";

// @x402/core exports no header-name constants, so ask its own HTTP client which names it uses
// instead of re-typing them. Neither probe touches `this` or the network.
const proto = x402HTTPClient.prototype;

function probeGetter(fn: (getHeader: (name: string) => string | undefined) => unknown): string[] {
  const seen: string[] = [];
  try { fn((name) => { seen.push(name); return undefined; }); } catch { /* expected: header absent */ }
  return seen.map((n) => n.toLowerCase());
}

/** Request headers carrying a payment (v2 first, then v1). */
export const PAYMENT_SIGNATURE_HEADERS: string[] = [2, 1].map((v) =>
  Object.keys(proto.encodePaymentSignatureHeader.call(null, { x402Version: v } as never))[0].toLowerCase());

/** Response header carrying the 402 payment requirements. */
export const PAYMENT_REQUIRED_HEADER: string =
  probeGetter((g) => proto.getPaymentRequiredResponse.call(null, g))[0];

/** Response headers carrying the settlement result (v2 first, then v1). */
export const PAYMENT_RESPONSE_HEADERS: string[] =
  probeGetter((g) => proto.getPaymentSettleResponse.call(null, g));
