import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { Funnel, funnel, type AppEnv } from "../src/funnel.js";
import { PAYMENT_SIGNATURE_HEADERS, PAYMENT_RESPONSE_HEADERS, PAYMENT_REQUIRED_HEADER } from "../src/x402-headers.js";

const HASH = "a".repeat(64);
const PAYER_A = "PAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PAYER_B = "PAYERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// Stand-in for paymentMiddleware: 402 without a payment header, 200 + settlement header with one,
// or a settlement failure when the payment header says "bad".
function appWith(f: Funnel) {
  const app = new Hono<AppEnv>();
  app.use("/v1/receipt", funnel(f));
  app.use("/v1/receipt", async (c, next) => {
    const pay = c.req.header(PAYMENT_SIGNATURE_HEADERS[0]);
    if (!pay) return c.json({}, 402);
    if (pay === "bad") return c.json({ error: "settle failed" }, 402);
    await next();
    c.header(PAYMENT_RESPONSE_HEADERS[0], encodePaymentResponseHeader({ success: true, payer: pay, transaction: "T", network: "algorand:x" }));
  });
  app.get("/v1/receipt", (c) => { c.set("receiptHash", HASH); return c.json({ hash: HASH }); });
  return app;
}

test("header names come from @x402/core and match what @x402/hono reads", () => {
  assert.deepEqual(PAYMENT_SIGNATURE_HEADERS, ["payment-signature", "x-payment"]);
  assert.equal(PAYMENT_REQUIRED_HEADER, "payment-required");
  assert.deepEqual(PAYMENT_RESPONSE_HEADERS, ["payment-response", "x-payment-response"]);
});

test("counters increment per event", async () => {
  const lines: string[] = [];
  const f = new Funnel((l) => lines.push(l));
  const app = appWith(f);
  await app.request("/v1/receipt?txid=X");
  await app.request("/v1/receipt", { headers: { [PAYMENT_SIGNATURE_HEADERS[0]]: PAYER_A } });
  await app.request("/v1/receipt", { headers: { [PAYMENT_SIGNATURE_HEADERS[0]]: "bad" } });
  assert.deepEqual(f.counters(), { requests: 3, issued402: 1, presented: 2, served: 1, failed: 1, uniquePayers: 1 });
  const evs = lines.map((l) => JSON.parse(l).ev);
  assert.deepEqual(evs, ["402_issued", "payment_presented", "served", "payment_presented", "payment_failed"]);
  assert.equal(JSON.parse(lines[0]).txid, true);
  for (const l of lines) assert.ok(typeof JSON.parse(l).ts === "string");
});

test("uniquePayers counts distinct payers only", async () => {
  const f = new Funnel(() => {});
  const app = appWith(f);
  for (const p of [PAYER_A, PAYER_B, PAYER_A, PAYER_A]) {
    await app.request("/v1/receipt", { headers: { [PAYMENT_SIGNATURE_HEADERS[0]]: p } });
  }
  assert.equal(f.counters().served, 4);
  assert.equal(f.counters().uniquePayers, 2);
});

test("served log line carries the hash and no payer address", async () => {
  const lines: string[] = [];
  const f = new Funnel((l) => lines.push(l));
  await appWith(f).request("/v1/receipt", { headers: { [PAYMENT_SIGNATURE_HEADERS[0]]: PAYER_A } });
  const served = lines.map((l) => JSON.parse(l)).find((e) => e.ev === "served");
  assert.equal(served.hash, HASH);
  assert.equal(served.status, 200);
  for (const l of lines) assert.ok(!l.includes(PAYER_A), `address leaked: ${l}`);
  assert.ok(!JSON.stringify(f.counters()).includes(PAYER_A));
});
