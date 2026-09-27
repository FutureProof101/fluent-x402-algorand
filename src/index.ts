import { config } from "dotenv";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { ResourceServerExtension } from "@x402/core/types";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402-avm/extensions";
import {
  ALGORAND_MAINNET_GENESIS_HASH,
  ALGORAND_TESTNET_GENESIS_HASH,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from "@x402/avm";
import type { ServiceConfig } from "./meta.js";
import { ReceiptStore } from "./store.js";
import { Funnel, funnel, type AppEnv } from "./funnel.js";
import { mountFree, mountPaid } from "./routes.js";

config();

const payTo = need("PAY_TO");
const facilitatorUrl = process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";
const net = (process.env.NETWORK ?? "mainnet").toLowerCase();
const isMainnet = net === "mainnet";
// The GoPlausible facilitator advertises the full genesis-hash form in /supported, and @x402/core
// matches route networks against that list by exact string, so use the same form here.
const network = `algorand:${isMainnet ? ALGORAND_MAINNET_GENESIS_HASH : ALGORAND_TESTNET_GENESIS_HASH}` as `${string}:${string}`;
const usdcAsa = isMainnet ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID;
const indexer = process.env.INDEXER_URL ?? (isMainnet
  ? "https://mainnet-idx.4160.nodely.dev"
  : "https://testnet-idx.4160.nodely.dev");
const price = process.env.PRICE ?? "$0.01";
const priceGroup = process.env.PRICE_GROUP ?? "$0.02";
const port = Number(process.env.PORT ?? 4021);
// Public origin. Railway terminates TLS, so the app sees http:// and would otherwise register the
// Bazaar resource URL without https. Set PUBLIC_URL to the public origin in production.
const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");

function need(k: string): string {
  const v = process.env[k];
  if (!v) { console.error(`Missing ${k}`); process.exit(1); }
  return v;
}

const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });
const server = new x402ResourceServer(facilitator).register(network, new ExactAvmScheme());
server.registerExtension(bazaarResourceServerExtension as unknown as ResourceServerExtension);

const receiptDiscovery = declareDiscoveryExtension({
  input: { txid: "BL53UR5MYRZ2XPMN5YATA55YZORMZXYEZI4NNIZTSZ2ERJERBMEQ" },
  inputSchema: {
    type: "object",
    properties: { txid: { type: "string", description: "Algorand transaction id (base32, 52 chars)" } },
    required: ["txid"],
  },
  output: {
    example: {
      receipt: {
        version: "fluent-receipt/1",
        network: isMainnet ? "algorand-mainnet" : "algorand-testnet",
        txid: "BL53UR5MYRZ2XPMN5YATA55YZORMZXYEZI4NNIZTSZ2ERJERBMEQ",
        type: "axfer",
        asset: "31566704",
        amount: "1990000",
        from: "PAYER…",
        to: "MERCHANT…",
        round: 64000000,
        roundTime: "2026-01-01T00:00:00.000Z",
        groupId: null,
        note: null,
        indexerSource: "mainnet-idx.4160.nodely.dev",
      },
      hash: "sha256 of the canonical receipt",
    },
  },
});

const groupDiscovery = declareDiscoveryExtension({
  input: { groupId: "urRYpkY24txRUle6bI6X0ScMP5EJpuk2QJ+P5w46/E8=", round: 64000000 },
  inputSchema: {
    type: "object",
    properties: {
      groupId: { type: "string", description: "Atomic group id (standard base64 of 32 bytes; percent-encode it)" },
      round: { type: "integer", description: "Confirmed round the group landed in" },
    },
    required: ["groupId", "round"],
  },
  output: {
    example: {
      proof: {
        version: "fluent-group-proof/1",
        network: isMainnet ? "algorand-mainnet" : "algorand-testnet",
        groupId: "urRYpkY24txRUle6bI6X0ScMP5EJpuk2QJ+P5w46/E8=",
        round: 64000000,
        complete: true,
        memberCount: 2,
        members: [
          { txid: "AAAA…", type: "axfer", sender: "PAYER…", receiver: "MERCHANT…", asset: "31566704", amount: "1990000", closeTo: null, rekeyTo: null, note: null },
          { txid: "BBBB…", type: "pay", sender: "PAYER…", receiver: "MERCHANT…", asset: null, amount: "1000", closeTo: null, rekeyTo: null, note: null },
        ],
        indexerSource: "mainnet-idx.4160.nodely.dev",
      },
      hash: "sha256 of the canonical proof",
    },
  },
});

const cfg: ServiceConfig = { payTo, network, usdcAsa, price, priceGroup, publicUrl, isMainnet };
const deps = { cfg, store: new ReceiptStore(), funnel: new Funnel(), indexer, startedAtMs: Date.now() };

const app = new Hono<AppEnv>();

// Free surface (discover, quote, receipt re-read, metadata) goes before the payment middleware.
mountFree(app, deps);

app.use("/v1/receipt", funnel(deps.funnel));
app.use("/v1/verify-group", funnel(deps.funnel));
app.use(paymentMiddleware({
  "GET /v1/receipt": {
    ...(publicUrl ? { resource: `${publicUrl}/v1/receipt` } : {}),
    accepts: [{ scheme: "exact", price, network, payTo, extra: { asset: usdcAsa } }],
    description: "Verified Algorand payment receipt: fetches a confirmed transaction from the indexer, normalises it to the Fluent receipt shape, and returns it with a canonical hash. Built for agents that need proof-of-payment records.",
    mimeType: "application/json",
    serviceName: "Fluent",
    tags: ["x402-global-challenge", "fluent", "receipt", "payments", "algorand"],
    extensions: receiptDiscovery,
  },
  "GET /v1/verify-group": {
    ...(publicUrl ? { resource: `${publicUrl}/v1/verify-group` } : {}),
    accepts: [{ scheme: "exact", price: priceGroup, network, payTo, extra: { asset: usdcAsa } }],
    description: "Round-pinned Algorand atomic-group verification: proves membership of a group at a round and returns the canonical tuple with a sha256",
    mimeType: "application/json",
    serviceName: "Fluent",
    tags: ["x402-global-challenge", "fluent", "receipt", "payments", "algorand", "group"],
    extensions: groupDiscovery,
  },
}, server));

mountPaid(app, deps);

serve({ fetch: app.fetch, port }, () => {
  console.log(`fluent-x402 listening on :${port} network=${net} payTo=${payTo} facilitator=${facilitatorUrl}`);
});
