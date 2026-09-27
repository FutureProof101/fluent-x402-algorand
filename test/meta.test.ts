import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROUTES, TXID_ERROR, SAMPLE_TXID, buildDiscovery, buildOpenApi, buildPricing, buildWellKnown, paidAccepts, quoteFor,
} from "../src/meta.js";
import { RECEIPT_FIELDS, buildReceipt } from "../src/receipt.js";
import { honoPath } from "../src/routes.js";
import { buildApp, forbidFetch, mainnetCfg } from "./helpers.js";

const cfg = mainnetCfg;

test("discovery reflects cfg", () => {
  const d = buildDiscovery(cfg);
  assert.deepEqual(d.networks, [cfg.network]);
  assert.equal(d.assets[0].id, cfg.usdcAsa);
  assert.equal(d.sample.txid, SAMPLE_TXID);
  assert.equal(d.links.openapi, "https://example.test/openapi.json");
  for (const k of ["openapi", "agentMd", "llmsTxt", "pricing", "status", "repo"]) assert.ok(k in d.links, k);
  const other = buildDiscovery({ ...cfg, price: "$0.02", publicUrl: "" });
  assert.equal(other.endpoints.find((e) => !e.free)!.price, "$0.02");
  assert.equal(other.links.pricing, "/pricing");
});

test("paid endpoint listed free:false, $0.01, asset 31566704 on mainnet", () => {
  const paid = buildDiscovery(cfg).endpoints.filter((e) => !e.free);
  assert.equal(paid.length, 1);
  assert.deepEqual(paid[0], {
    method: "GET", path: "/v1/receipt", price: "$0.01", asset: "31566704", free: false, description: paid[0].description,
  });
  assert.deepEqual(buildPricing(cfg).endpoints, buildDiscovery(cfg).endpoints);
});

test("quote: valid txid -> 200 shape, no fetch", async () => {
  const f = forbidFetch();
  try {
    const { app } = buildApp();
    const res = await app.request(`/quote?txid=${SAMPLE_TXID}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      txid: SAMPLE_TXID, price: "$0.01", asset: "31566704", payTo: cfg.payTo, network: cfg.network,
      willContain: [...RECEIPT_FIELDS],
      pay: { method: "x402", header: "payment-required", endpoint: `https://example.test/v1/receipt?txid=${SAMPLE_TXID}` },
    });
    assert.equal(f.calls, 0);
  } finally { f.restore(); }
});

test("quote: invalid txid -> 400 with the paid route's message", async () => {
  const { app } = buildApp();
  for (const bad of ["", "abc", SAMPLE_TXID.toLowerCase(), SAMPLE_TXID + "A"]) {
    const res = await app.request(`/quote?txid=${bad}`);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: TXID_ERROR });
    const paid = await app.request(`/v1/receipt?txid=${bad}`); // bare app: no middleware
    assert.deepEqual(await paid.json(), { error: TXID_ERROR });
  }
  assert.equal(quoteFor(cfg, "x").ok, false);
});

test("every free route answers without a network call", async () => {
  const f = forbidFetch();
  try {
    const { app } = buildApp();
    for (const r of ROUTES.filter((x) => x.free)) {
      const path = r.path.replace("{hash}", "0".repeat(64)) + (r.path === "/quote" ? `?txid=${SAMPLE_TXID}` : "");
      const res = await app.request(path);
      assert.ok(res.status === 200 || (r.path === "/receipt/{hash}" && res.status === 404), `${r.path} -> ${res.status}`);
    }
    assert.equal(f.calls, 0);
  } finally { f.restore(); }
});

test("openapi lists exactly the routes registered", () => {
  const { app } = buildApp();
  const registered = app.routes.filter((r) => r.method === "GET").map((r) => r.path).sort();
  const spec = buildOpenApi(cfg);
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(Object.keys(spec.paths).map(honoPath).sort(), registered);
  const paid = spec.paths["/v1/receipt"].get as { responses: Record<string, { headers?: object }> };
  assert.ok(paid.responses["402"], "402 response documented");
  assert.ok(paid.responses["402"].headers && "PAYMENT-REQUIRED" in paid.responses["402"].headers);
});

test("well-known accepts equals the middleware config's accepts", () => {
  const wk = buildWellKnown(cfg);
  assert.deepEqual(wk.resources[0].accepts, paidAccepts(cfg));
  // paidAccepts is what src/index.ts hands paymentMiddleware; pin the shape it had inline at 7701278.
  const { price, network, payTo, usdcAsa } = cfg;
  assert.deepEqual(paidAccepts(cfg), [{ scheme: "exact", price, network, payTo, extra: { asset: usdcAsa } }]);
});

test("receipt re-read: unknown -> 404, paid result -> stored and re-readable", async () => {
  const { app, deps } = buildApp();
  const miss = await app.request(`/receipt/${"f".repeat(64)}`);
  assert.equal(miss.status, 404);
  assert.deepEqual(await miss.json(), { error: "no receipt with that hash" });

  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ transaction: fakeTx() }))) as typeof globalThis.fetch;
  try {
    const paid = await app.request(`/v1/receipt?txid=${SAMPLE_TXID}`);
    assert.equal(paid.status, 200);
    const body = await paid.json() as { hash: string };
    assert.equal(deps.store.size(), 1);
    const hit = await app.request(`/receipt/${body.hash}`);
    assert.equal(hit.status, 200);
    assert.deepEqual(await hit.json(), body);
  } finally { globalThis.fetch = orig; }
});

test("RECEIPT_FIELDS matches the receipt buildReceipt produces, in order", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ transaction: fakeTx() }))) as typeof globalThis.fetch;
  try {
    const r = await buildReceipt("https://indexer.invalid", SAMPLE_TXID, true);
    assert.ok("receipt" in r);
    assert.deepEqual(Object.keys(r.receipt), [...RECEIPT_FIELDS]);
  } finally { globalThis.fetch = orig; }
});

function fakeTx() {
  return {
    id: SAMPLE_TXID, "tx-type": "axfer", sender: "S", "confirmed-round": 1, "round-time": 1700000000,
    "asset-transfer-transaction": { "asset-id": 31566704, amount: 10000, receiver: "R" },
  };
}
