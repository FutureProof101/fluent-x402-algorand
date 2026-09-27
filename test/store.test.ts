import { test } from "node:test";
import assert from "node:assert/strict";
import { ReceiptStore, RECEIPT_STORE_CAP } from "../src/store.js";

test("put/get round-trip", () => {
  const s = new ReceiptStore<{ n: number }>();
  s.put("a", { n: 1 });
  assert.deepEqual(s.get("a"), { n: 1 });
  assert.equal(s.size(), 1);
});

test("get of unknown is undefined", () => {
  assert.equal(new ReceiptStore().get("nope"), undefined);
});

test("cap is 1000 and cap+1 evicts the oldest", () => {
  assert.equal(RECEIPT_STORE_CAP, 1000);
  const s = new ReceiptStore<number>();
  for (let i = 0; i <= RECEIPT_STORE_CAP; i++) s.put(`h${i}`, i);
  assert.equal(s.size(), RECEIPT_STORE_CAP);
  assert.equal(s.get("h0"), undefined);
  assert.equal(s.get("h1"), 1);
  assert.equal(s.get(`h${RECEIPT_STORE_CAP}`), RECEIPT_STORE_CAP);
});

test("re-put refreshes position so it is not evicted next", () => {
  const s = new ReceiptStore<number>(2);
  s.put("a", 1); s.put("b", 2); s.put("a", 3); s.put("c", 4);
  assert.equal(s.get("b"), undefined);
  assert.equal(s.get("a"), 3);
});
