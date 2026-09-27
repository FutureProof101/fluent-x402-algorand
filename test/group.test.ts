import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GROUP_FIELDS, GROUP_ID_ERROR, MEMBER_FIELDS, ROUND_ERROR, SAMPLE_GROUP, buildGroupProof, groupQueryUrl, parseGroupQuery,
} from "../src/group.js";
import { buildApp, forbidFetch } from "./helpers.js";

const { groupId: GID, round: ROUND } = SAMPLE_GROUP;
const IDX = "https://indexer.invalid";
const b64 = (n: number) => Buffer.alloc(n, 7).toString("base64");

function member(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, "tx-type": "axfer", sender: "S", group: GID, "confirmed-round": ROUND, "round-time": 1700000000,
    "asset-transfer-transaction": { "asset-id": 31566704, amount: 10000, receiver: "R" }, ...extra,
  };
}

/** Stubs fetch with an indexer group response; records the URLs asked for. */
function stubIndexer(transactions: unknown[], status = 200) {
  const orig = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (u: string | URL) => {
    urls.push(String(u));
    return new Response(JSON.stringify({ "current-round": 99999999, "next-token": "VOLATILE-TOKEN", transactions }), { status });
  }) as typeof globalThis.fetch;
  return { urls, restore: () => { globalThis.fetch = orig; } };
}

async function proofOf(transactions: unknown[]) {
  const s = stubIndexer(transactions);
  try { return await buildGroupProof(IDX, GID, ROUND, true); } finally { s.restore(); }
}

test("parseGroupQuery: groupId must be base64 of exactly 32 bytes", () => {
  assert.equal(b64(32).length, 44);
  assert.deepEqual(parseGroupQuery(b64(32), "1"), { ok: true, groupId: b64(32), round: 1 });
  for (const bad of [b64(31), b64(33), "", "abc", GID.replace("=", ""), GID + "=", GID.slice(0, 42) + "-_="]) {
    assert.deepEqual(parseGroupQuery(bad, "1"), { ok: false, status: 400, error: GROUP_ID_ERROR }, bad);
  }
  // non-canonical trailing bits decode to 32 bytes but are not the canonical encoding
  assert.equal(parseGroupQuery(GID.slice(0, 42) + "F=", "1").ok, false);
  // an unencoded "+" arrives as a space
  assert.deepEqual(parseGroupQuery(GID.replace("+", " "), "1"), { ok: true, groupId: GID, round: 1 });
});

test("parseGroupQuery: round must be a positive integer <= 2^53", () => {
  for (const bad of ["0", "", "-1", "1.5", "01", "1e3", " 1", String(2n ** 53n + 1n), "abc"]) {
    assert.deepEqual(parseGroupQuery(GID, bad), { ok: false, status: 400, error: ROUND_ERROR }, bad);
  }
  assert.deepEqual(parseGroupQuery(GID, String(2n ** 53n)), { ok: true, groupId: GID, round: 2 ** 53 });
});

test("groupQueryUrl percent-encodes the id and pins the round", () => {
  const u = groupQueryUrl(IDX, GID, ROUND);
  assert.equal(u, `${IDX}/v2/transactions?group-id=${encodeURIComponent(GID)}&min-round=${ROUND}&max-round=${ROUND}&limit=4`);
  assert.ok(u.includes("urRYpkY24txRUle6bI6X0ScMP5EJpuk2QJ%2BP5w46%2FE8%3D"));
  assert.ok(u.includes(`min-round=${ROUND}&max-round=${ROUND}&limit=4`));
});

test("no fetch on validation failure", async () => {
  const f = forbidFetch();
  try {
    const { app } = buildApp();
    for (const [q, err] of [
      [`groupId=${encodeURIComponent(b64(31))}&round=1`, GROUP_ID_ERROR],
      [`groupId=${encodeURIComponent(b64(33))}&round=1`, GROUP_ID_ERROR],
      [`groupId=${encodeURIComponent(GID)}&round=0`, ROUND_ERROR],
      [`round=1`, GROUP_ID_ERROR],
    ]) {
      const res = await app.request(`/v1/verify-group?${q}`);
      assert.equal(res.status, 400, q);
      assert.deepEqual(await res.json(), { error: err });
    }
    assert.equal(f.calls, 0);
  } finally { f.restore(); }
});

test("members come out ordered by txid ascending, whatever the response order", async () => {
  const r = await proofOf([member("ZZZZ"), member("AAAA", { "tx-type": "pay", "asset-transfer-transaction": undefined, "payment-transaction": { amount: 5, receiver: "P" } })]);
  assert.ok("proof" in r);
  assert.deepEqual(r.proof.members.map((m) => m.txid), ["AAAA", "ZZZZ"]);
  assert.deepEqual(r.proof.members[0], {
    txid: "AAAA", type: "pay", sender: "S", receiver: "P", asset: null, amount: "5", closeTo: null, rekeyTo: null, note: null,
  });
  assert.equal(r.proof.complete, true);
  assert.equal(r.proof.memberCount, 2);
  assert.deepEqual(Object.keys(r.proof), [...GROUP_FIELDS]);
  for (const m of r.proof.members) assert.deepEqual(Object.keys(m), [...MEMBER_FIELDS]);
});

test("a full page (4 members) is complete:false", async () => {
  const r = await proofOf(["D", "C", "B", "A"].map((id) => member(id)));
  assert.ok("proof" in r);
  assert.equal(r.proof.complete, false);
  assert.equal(r.proof.memberCount, 4);
});

test("hash is stable across builds and response order; volatile fields never enter the proof", async () => {
  const a = await proofOf([member("AAAA"), member("BBBB")]);
  const b = await proofOf([member("BBBB"), member("AAAA")]);
  assert.ok("hash" in a && "hash" in b);
  assert.equal(a.hash, b.hash);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  const hashed = JSON.stringify(a.proof);
  for (const v of ["current-round", "next-token", "VOLATILE-TOKEN", "99999999"]) assert.ok(!hashed.includes(v), v);
});

test("error mapping: empty -> 404, indexer 404 -> 404, non-200 -> 502, foreign tx -> 502", async () => {
  assert.deepEqual(await proofOf([]), { error: "no transactions in that group at that round", status: 404 });
  for (const [status, want] of [[404, 404], [500, 502]] as const) {
    const s = stubIndexer([], status);
    try { assert.equal(((await buildGroupProof(IDX, GID, ROUND, true)) as { status: number }).status, want); } finally { s.restore(); }
  }
  assert.equal(((await proofOf([member("A", { group: b64(32) })])) as { status: number }).status, 502);
  assert.equal(((await proofOf([member("A", { "confirmed-round": ROUND + 1 })])) as { status: number }).status, 502);
});

test("paid handler stores the proof under its hash, readable at /receipt/{hash}", async () => {
  const { app, deps } = buildApp();
  const s = stubIndexer([member("BBBB"), member("AAAA")]);
  try {
    const paid = await app.request(`/v1/verify-group?groupId=${encodeURIComponent(GID)}&round=${ROUND}`);
    assert.equal(paid.status, 200);
    assert.equal(s.urls.length, 1);
    assert.equal(s.urls[0], groupQueryUrl(IDX, GID, ROUND));
    const body = await paid.json() as { hash: string; proof: { network: string } };
    assert.equal(body.proof.network, "algorand-mainnet");
    assert.equal(deps.store.size(), 1);
    const hit = await app.request(`/receipt/${body.hash}`);
    assert.equal(hit.status, 200);
    assert.deepEqual(await hit.json(), body);
  } finally { s.restore(); }
});
