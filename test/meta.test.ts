import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ROUTES, TXID_ERROR, SAMPLE_TXID, buildAgentMd, buildDiscovery, buildLlmsTxt, buildOpenApi, buildPricing, buildWellKnown,
  paidAccepts, quoteFor, quoteForGroup,
} from "../src/meta.js";
import { RECEIPT_FIELDS, buildReceipt } from "../src/receipt.js";
import { GROUP_FIELDS, GROUP_ID_ERROR, MEMBER_FIELDS, ROUND_ERROR, SAMPLE_GROUP } from "../src/group.js";
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

test("both paid endpoints listed free:false with distinct prices, asset 31566704 on mainnet", () => {
  assert.deepEqual(ROUTES.filter((r) => !r.free).map((r) => r.path), ["/v1/receipt", "/v1/verify-group"]);
  const paid = buildDiscovery(cfg).endpoints.filter((e) => !e.free);
  assert.equal(paid.length, 2);
  assert.deepEqual(paid[0], {
    method: "GET", path: "/v1/receipt", price: "$0.01", asset: "31566704", free: false, description: paid[0].description,
  });
  assert.deepEqual(paid[1], {
    method: "GET", path: "/v1/verify-group", price: "$0.02", asset: "31566704", free: false, description: paid[1].description,
  });
  assert.deepEqual(buildPricing(cfg).endpoints, buildDiscovery(cfg).endpoints);
  const repriced = buildDiscovery({ ...cfg, priceGroup: "$0.05" }).endpoints.filter((e) => !e.free).map((e) => e.price);
  assert.deepEqual(repriced, ["$0.01", "$0.05"]);
});

test("every free surface lists both paid routes", async () => {
  const f = forbidFetch();
  try {
    const { app } = buildApp();
    const read = async (p: string) => { const r = await app.request(p); assert.equal(r.status, 200, p); return r.text(); };
    for (const p of ["/", "/discover", "/pricing", "/openapi.json", "/agent.md", "/llms.txt", "/.well-known/x402"]) {
      const body = await read(p);
      for (const paid of ["/v1/receipt", "/v1/verify-group"]) assert.ok(body.includes(paid), `${p} missing ${paid}`);
    }
    assert.ok(buildAgentMd(cfg).includes("$0.02") && buildLlmsTxt(cfg).includes("$0.02"));
    assert.ok(buildDiscovery(cfg).capabilities.includes("algorand-group-proof"));
    assert.equal(f.calls, 0);
  } finally { f.restore(); }
});

test("quote: group input -> $0.02 and proof field names, no fetch", async () => {
  const f = forbidFetch();
  try {
    const { app } = buildApp();
    const res = await app.request(`/quote?groupId=${encodeURIComponent(SAMPLE_GROUP.groupId)}&round=${SAMPLE_GROUP.round}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      groupId: SAMPLE_GROUP.groupId, round: SAMPLE_GROUP.round, price: "$0.02", asset: "31566704", payTo: cfg.payTo, network: cfg.network,
      willContain: [...GROUP_FIELDS], memberFields: [...MEMBER_FIELDS],
      pay: {
        method: "x402", header: "payment-required",
        endpoint: `https://example.test/v1/verify-group?groupId=${encodeURIComponent(SAMPLE_GROUP.groupId)}&round=${SAMPLE_GROUP.round}`,
      },
    });
    const bad = await app.request(`/quote?groupId=abc&round=1`);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: GROUP_ID_ERROR });
    const badRound = await app.request(`/quote?groupId=${encodeURIComponent(SAMPLE_GROUP.groupId)}&round=0`);
    assert.deepEqual(await badRound.json(), { error: ROUND_ERROR });
    assert.equal(quoteForGroup(cfg, SAMPLE_GROUP.groupId, "1").ok, true);
    assert.equal(f.calls, 0);
  } finally { f.restore(); }
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
  for (const p of ["/v1/receipt", "/v1/verify-group"]) {
    const paid = spec.paths[p].get as { responses: Record<string, { headers?: object }>; "x-x402": { price: string } };
    assert.ok(paid.responses["402"], "402 response documented");
    assert.ok(paid.responses["402"].headers && "PAYMENT-REQUIRED" in paid.responses["402"].headers);
    assert.equal(paid["x-x402"].price, p === "/v1/receipt" ? "$0.01" : "$0.02");
  }
});

test("well-known has two resources whose accepts equal the middleware config's accepts", () => {
  const wk = buildWellKnown(cfg);
  assert.deepEqual(wk.resources.map((r) => r.path), ["/v1/receipt", "/v1/verify-group"]);
  assert.deepEqual(wk.resources[0].accepts, paidAccepts(cfg));
  assert.deepEqual(wk.resources[1].accepts, paidAccepts(cfg, "/v1/verify-group"));
  // src/index.ts hands paymentMiddleware inline literals (the receipt one kept exactly as at 7701278). Pin
  // those lines, then evaluate them with cfg's values so the literals and the derived free form cannot drift.
  const PIN_LITERAL = '[{ scheme: "exact", price, network, payTo, extra: { asset: usdcAsa } }]';
  const GROUP_LITERAL = '[{ scheme: "exact", price: priceGroup, network, payTo, extra: { asset: usdcAsa } }]';
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const lines = src.split("\n").filter((l) => l.trimStart().startsWith("accepts:"));
  assert.deepEqual(lines, [`    accepts: ${PIN_LITERAL},`, `    accepts: ${GROUP_LITERAL},`]);
  const { price, priceGroup, network, payTo, usdcAsa } = cfg;
  const evalLit = (lit: string) =>
    new Function("price", "priceGroup", "network", "payTo", "usdcAsa", `return ${lit};`)(price, priceGroup, network, payTo, usdcAsa);
  assert.deepEqual(wk.resources[0].accepts, evalLit(PIN_LITERAL));
  assert.deepEqual(wk.resources[1].accepts, evalLit(GROUP_LITERAL));
  assert.notDeepEqual(wk.resources[0].accepts, wk.resources[1].accepts);
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

test("receipt hash unchanged by the shared leg extraction (value computed at pin ef5f928)", async () => {
  const tx = {
    ...fakeTx(), group: "G", note: "bm90ZQ==", "rekey-to": "K",
    "asset-transfer-transaction": { "asset-id": 31566704, amount: 10000, receiver: "R", "close-to": "C" },
  };
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ transaction: tx }))) as typeof globalThis.fetch;
  try {
    const r = await buildReceipt("https://indexer.invalid", SAMPLE_TXID, true);
    assert.ok("hash" in r);
    assert.equal(r.hash, "ae5f51d1493a730f327573bf9ec3d533da1555d320131a79c75d68e7ada1246e");
  } finally { globalThis.fetch = orig; }
});

function fakeTx() {
  return {
    id: SAMPLE_TXID, "tx-type": "axfer", sender: "S", "confirmed-round": 1, "round-time": 1700000000,
    "asset-transfer-transaction": { "asset-id": 31566704, amount: 10000, receiver: "R" },
  };
}
