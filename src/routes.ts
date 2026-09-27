import type { Context, Hono } from "hono";
import { buildReceipt, type Ok } from "./receipt.js";
import type { ReceiptStore } from "./store.js";
import type { AppEnv, Funnel } from "./funnel.js";
import {
  ROUTES, TXID_ERROR, TXID_RE, REPO_URL, networkName, buildAgentMd, buildDiscovery, buildLlmsTxt, buildOpenApi,
  buildPricing, buildStatus, buildWellKnown, quoteFor, type ServiceConfig,
} from "./meta.js";

export type RouteDeps = {
  cfg: ServiceConfig;
  store: ReceiptStore<Ok>;
  funnel: Funnel;
  indexer: string;
  startedAtMs: number;
};

type Handler = (c: Context<AppEnv>) => Response | Promise<Response>;

function handlers(d: RouteDeps): Record<string, Handler> {
  const { cfg } = d;
  return {
    "/": (c) => c.json({
      service: "Fluent x402 receipt endpoint (Algorand)",
      network: networkName(cfg),
      paid: { "GET /v1/receipt?txid=<txid>": { price: cfg.price, asset: `USDC ASA ${cfg.usdcAsa}`, payTo: cfg.payTo } },
      free: ROUTES.filter((r) => r.free).map((r) => `${r.method} ${r.path}`),
      publicUrl: cfg.publicUrl || null,
      docs: REPO_URL,
    }),
    "/health": (c) => c.json({ ok: true, ts: new Date().toISOString() }),
    "/discover": (c) => c.json(buildDiscovery(cfg)),
    "/quote": (c) => {
      const q = quoteFor(cfg, c.req.query("txid") ?? "");
      return q.ok ? c.json(q.body) : c.json({ error: q.error }, q.status);
    },
    "/receipt/{hash}": (c) => {
      const hit = d.store.get(c.req.param("hash") ?? "");
      return hit ? c.json(hit) : c.json({ error: "no receipt with that hash" }, 404);
    },
    "/pricing": (c) => c.json(buildPricing(cfg)),
    "/status": (c) => c.json(buildStatus(cfg, d.startedAtMs, Date.now(), d.funnel.counters())),
    "/openapi.json": (c) => c.json(buildOpenApi(cfg)),
    "/agent.md": (c) => c.body(buildAgentMd(cfg), 200, { "content-type": "text/markdown; charset=utf-8" }),
    "/llms.txt": (c) => c.text(buildLlmsTxt(cfg)),
    "/.well-known/x402": (c) => c.json(buildWellKnown(cfg)),
    "/v1/receipt": async (c) => {
      const txid = c.req.query("txid") ?? "";
      if (!TXID_RE.test(txid)) return c.json({ error: TXID_ERROR }, 400);
      const r = await buildReceipt(d.indexer, txid, cfg.isMainnet);
      if ("error" in r) return c.json({ error: r.error }, r.status);
      d.store.put(r.hash, r);
      c.set("receiptHash", r.hash);
      return c.json(r);
    },
  };
}

/** OpenAPI path template to Hono pattern: /receipt/{hash} -> /receipt/:hash */
export const honoPath = (p: string) => p.replace(/\{(\w+)\}/g, ":$1");

function mount(app: Hono<AppEnv>, d: RouteDeps, free: boolean): void {
  const h = handlers(d);
  for (const r of ROUTES.filter((x) => x.free === free)) {
    const fn = h[r.path];
    if (!fn) throw new Error(`no handler for ${r.method} ${r.path}`);
    app.get(honoPath(r.path), fn);
  }
}

/** Free routes: register BEFORE paymentMiddleware so they are never gated. */
export const mountFree = (app: Hono<AppEnv>, d: RouteDeps) => mount(app, d, true);
/** Paid route handlers: register AFTER paymentMiddleware. */
export const mountPaid = (app: Hono<AppEnv>, d: RouteDeps) => mount(app, d, false);
