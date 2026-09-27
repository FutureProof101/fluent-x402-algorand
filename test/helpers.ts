import { Hono } from "hono";
import { USDC_MAINNET_ASA_ID, ALGORAND_MAINNET_GENESIS_HASH } from "@x402/avm";
import type { ServiceConfig } from "../src/meta.js";
import { ReceiptStore } from "../src/store.js";
import { Funnel, type AppEnv } from "../src/funnel.js";
import { mountFree, mountPaid, type RouteDeps } from "../src/routes.js";

export const PAY_TO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";

export const mainnetCfg: ServiceConfig = {
  payTo: PAY_TO,
  network: `algorand:${ALGORAND_MAINNET_GENESIS_HASH}`,
  usdcAsa: USDC_MAINNET_ASA_ID,
  price: "$0.01",
  publicUrl: "https://example.test",
  isMainnet: true,
};

/** The full route set on a bare app (no payment middleware), with fetch stubbed to fail loudly. */
export function buildApp(cfg = mainnetCfg) {
  const lines: string[] = [];
  const deps: RouteDeps = {
    cfg, store: new ReceiptStore(), funnel: new Funnel((l) => lines.push(l)), indexer: "https://indexer.invalid", startedAtMs: Date.now(),
  };
  const app = new Hono<AppEnv>();
  mountFree(app, deps);
  mountPaid(app, deps);
  return { app, deps, lines };
}

export function forbidFetch(): { calls: number; restore: () => void } {
  const orig = globalThis.fetch;
  const state = { calls: 0, restore: () => { globalThis.fetch = orig; } };
  globalThis.fetch = (async () => { state.calls++; throw new Error("network call on a free route"); }) as typeof globalThis.fetch;
  return state;
}
