import { RECEIPT_FIELDS } from "./receipt.js";
import { RECEIPT_STORE_CAP } from "./store.js";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADERS, PAYMENT_RESPONSE_HEADERS } from "./x402-headers.js";

// Pure builders for the free metadata surface. Everything here is derived from ServiceConfig, the
// same values the paid route's paymentMiddleware config uses, so /discover, /pricing, /openapi.json
// and /.well-known/x402 cannot disagree with the 402 the server actually issues.

export type ServiceConfig = {
  payTo: string;
  network: `${string}:${string}`;
  usdcAsa: string;
  price: string;
  publicUrl: string; // "" when unset; links are then relative
  isMainnet: boolean;
};

export const REPO_URL = "https://github.com/FutureProof101/fluent-x402-algorand";
export const SAMPLE_TXID = "BL53UR5MYRZ2XPMN5YATA55YZORMZXYEZI4NNIZTSZ2ERJERBMEQ";
export const TXID_RE = /^[A-Z2-7]{52}$/;
export const TXID_ERROR = "txid must be a 52-char base32 Algorand transaction id";
export const PAID_PATH = "/v1/receipt";

/** The paid route's accepts[] derived from cfg for /.well-known/x402. src/index.ts keeps its own inline
 *  literal; test/meta.test.ts checks the two stay equal. */
export function paidAccepts(cfg: ServiceConfig) {
  return [{ scheme: "exact", price: cfg.price, network: cfg.network, payTo: cfg.payTo, extra: { asset: cfg.usdcAsa } }];
}

export function networkName(cfg: ServiceConfig): string {
  return cfg.isMainnet ? "algorand-mainnet" : "algorand-testnet";
}

type Param = { name: string; in: "query" | "path"; description: string; pattern?: string };
export type RouteSpec = {
  method: "GET";
  path: string; // OpenAPI form, e.g. /receipt/{hash}
  free: boolean;
  summary: string;
  contentType: "application/json" | "text/markdown" | "text/plain";
  params?: Param[];
};

const txidParam: Param = {
  name: "txid", in: "query", description: "Algorand transaction id (base32, 52 chars)", pattern: TXID_RE.source,
};

/** Single route table: registration, /discover, /pricing and /openapi.json all read from this. */
export const ROUTES: readonly RouteSpec[] = [
  { method: "GET", path: "/", free: true, contentType: "application/json", summary: "Service description" },
  { method: "GET", path: "/health", free: true, contentType: "application/json", summary: "Liveness" },
  { method: "GET", path: "/discover", free: true, contentType: "application/json", summary: "What this service sells, prices, endpoints and links" },
  { method: "GET", path: "/quote", free: true, contentType: "application/json", summary: "Price and receipt shape for a txid, before paying. No network call", params: [txidParam] },
  { method: "GET", path: "/receipt/{hash}", free: true, contentType: "application/json", summary: "Re-read a receipt already bought, by its sha256 hash (process-local cache)", params: [{ name: "hash", in: "path", description: "sha256 hex of the canonical receipt", pattern: "^[0-9a-f]{64}$" }] },
  { method: "GET", path: "/pricing", free: true, contentType: "application/json", summary: "Machine-readable price list" },
  { method: "GET", path: "/status", free: true, contentType: "application/json", summary: "Uptime and funnel counters" },
  { method: "GET", path: "/openapi.json", free: true, contentType: "application/json", summary: "OpenAPI 3.1 description of every route" },
  { method: "GET", path: "/agent.md", free: true, contentType: "text/markdown", summary: "How an agent buys a receipt" },
  { method: "GET", path: "/llms.txt", free: true, contentType: "text/plain", summary: "llms.txt index" },
  { method: "GET", path: "/.well-known/x402", free: true, contentType: "application/json", summary: "Mirror of the paid route's x402 accepts[]" },
  { method: "GET", path: PAID_PATH, free: false, contentType: "application/json", summary: "Verified Algorand payment receipt with canonical sha256 hash", params: [txidParam] },
];

function url(cfg: ServiceConfig, path: string): string {
  return `${cfg.publicUrl}${path}`;
}

function endpoints(cfg: ServiceConfig) {
  return ROUTES.map((r) => ({
    method: r.method,
    path: r.path,
    price: r.free ? "$0" : cfg.price,
    asset: r.free ? null : cfg.usdcAsa,
    free: r.free,
    description: r.summary,
  }));
}

function links(cfg: ServiceConfig) {
  return {
    openapi: url(cfg, "/openapi.json"),
    agentMd: url(cfg, "/agent.md"),
    llmsTxt: url(cfg, "/llms.txt"),
    pricing: url(cfg, "/pricing"),
    status: url(cfg, "/status"),
    repo: REPO_URL,
  };
}

const HEADLINE = "Software buying a proof of payment: one x402 call turns a confirmed Algorand transaction into a normalised, hashed receipt.";

export function buildDiscovery(cfg: ServiceConfig) {
  return {
    service: "Fluent x402 receipt endpoint (Algorand)",
    headline: HEADLINE,
    capabilities: ["algorand-transaction-receipt", "canonical-sha256-hash", "free-quote", "free-receipt-reread", "x402-exact-usdc"],
    networks: [cfg.network],
    assets: [{ id: cfg.usdcAsa, symbol: "USDC", decimals: 6, network: cfg.network }],
    endpoints: endpoints(cfg),
    sample: { txid: SAMPLE_TXID },
    links: links(cfg),
  };
}

export function buildPricing(cfg: ServiceConfig) {
  return {
    currency: "USD",
    settlement: { asset: cfg.usdcAsa, symbol: "USDC", network: cfg.network, payTo: cfg.payTo, scheme: "exact" },
    endpoints: endpoints(cfg),
  };
}

export type Quote =
  | { ok: true; body: ReturnType<typeof quoteBody> }
  | { ok: false; status: 400; error: string };

function quoteBody(cfg: ServiceConfig, txid: string) {
  return {
    txid,
    price: cfg.price,
    asset: cfg.usdcAsa,
    payTo: cfg.payTo,
    network: cfg.network,
    willContain: [...RECEIPT_FIELDS],
    pay: { method: "x402", header: PAYMENT_REQUIRED_HEADER, endpoint: url(cfg, `${PAID_PATH}?txid=${txid}`) },
  };
}

/** Pure: validates the txid and describes what paying would return. Never touches the network. */
export function quoteFor(cfg: ServiceConfig, txid: string): Quote {
  if (!TXID_RE.test(txid)) return { ok: false, status: 400, error: TXID_ERROR };
  return { ok: true, body: quoteBody(cfg, txid) };
}

export function buildWellKnown(cfg: ServiceConfig) {
  return {
    x402Version: 2,
    resources: [{
      method: "GET",
      path: PAID_PATH,
      resource: url(cfg, PAID_PATH),
      mimeType: "application/json",
      accepts: paidAccepts(cfg),
    }],
  };
}

export function buildStatus(cfg: ServiceConfig, startedAtMs: number, nowMs: number, counters: Record<string, number>) {
  return { ok: true, network: cfg.network, uptimeSeconds: Math.floor((nowMs - startedAtMs) / 1000), counters };
}

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;

const receiptSchema = {
  type: "object",
  required: [...RECEIPT_FIELDS],
  properties: {
    version: { type: "string", const: "fluent-receipt/1" },
    network: str, txid: str, type: str, asset: nullableStr, amount: str, from: str, to: nullableStr,
    closeTo: nullableStr, rekeyTo: nullableStr, round: { type: "integer" }, roundTime: { type: "string", format: "date-time" },
    groupId: nullableStr, note: nullableStr, indexerSource: str,
  },
};

const receiptResultSchema = {
  type: "object",
  required: ["receipt", "hash"],
  properties: { receipt: receiptSchema, hash: { type: "string", pattern: "^[0-9a-f]{64}$" } },
};

const errorSchema = { type: "object", required: ["error"], properties: { error: str } };

const paymentRequiredSchema = {
  type: "object",
  description: `Decoded ${PAYMENT_REQUIRED_HEADER} header (base64 JSON). The body mirrors it.`,
  required: ["x402Version", "accepts"],
  properties: {
    x402Version: { type: "integer" },
    error: str,
    resource: { type: "object" },
    accepts: {
      type: "array",
      items: {
        type: "object",
        required: ["scheme", "network", "amount", "asset", "payTo"],
        properties: {
          scheme: str, network: str, amount: { type: "string", description: "atomic units" }, asset: str, payTo: str,
          maxTimeoutSeconds: { type: "integer" }, extra: { type: "object" },
        },
      },
    },
    extensions: { type: "object" },
  },
};

function responsesFor(r: RouteSpec) {
  const json = (schema: object, description: string) => ({ description, content: { "application/json": { schema } } });
  if (!r.free) {
    return {
      "200": { ...json(receiptResultSchema, "Receipt and canonical hash"), headers: { [PAYMENT_RESPONSE_HEADERS[0].toUpperCase()]: { description: "base64 JSON settlement result", schema: str } } },
      "400": json(errorSchema, "Malformed txid"),
      "402": { ...json(paymentRequiredSchema, "Payment required"), headers: { [PAYMENT_REQUIRED_HEADER.toUpperCase()]: { description: "base64 JSON PaymentRequired", schema: str } } },
      "404": json(errorSchema, "Transaction not found or not confirmed"),
      "502": json(errorSchema, "Indexer unreachable"),
    };
  }
  if (r.path === "/quote") return { "200": json({ type: "object" }, r.summary), "400": json(errorSchema, "Malformed txid") };
  if (r.path === "/receipt/{hash}") return { "200": json(receiptResultSchema, r.summary), "404": json(errorSchema, "No receipt with that hash") };
  if (r.contentType !== "application/json") return { "200": { description: r.summary, content: { [r.contentType]: { schema: str } } } };
  return { "200": json({ type: "object" }, r.summary) };
}

export function buildOpenApi(cfg: ServiceConfig) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    paths[r.path] = {
      [r.method.toLowerCase()]: {
        summary: r.summary,
        ...(r.params ? { parameters: r.params.map((p) => ({ name: p.name, in: p.in, required: true, description: p.description, schema: { type: "string", ...(p.pattern ? { pattern: p.pattern } : {}) } })) } : {}),
        responses: responsesFor(r),
        ...(r.free ? {} : { "x-x402": { price: cfg.price, asset: cfg.usdcAsa, network: cfg.network, payTo: cfg.payTo, scheme: "exact" } }),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Fluent x402 receipt endpoint (Algorand)", version: "0.1.0", description: HEADLINE },
    ...(cfg.publicUrl ? { servers: [{ url: cfg.publicUrl }] } : {}),
    paths,
  };
}

export function buildAgentMd(cfg: ServiceConfig): string {
  const u = (p: string) => url(cfg, p);
  return `# Fluent x402 receipt endpoint (${networkName(cfg)})

## What it sells
One call to \`GET ${PAID_PATH}?txid=<txid>\` returns a normalised receipt for a confirmed Algorand
transaction plus the sha256 of its canonical JSON. Price: ${cfg.price} in USDC (ASA ${cfg.usdcAsa}),
paid to \`${cfg.payTo}\` on \`${cfg.network}\`.

## How to pay
x402 v2, scheme \`exact\`.
1. Request the paid URL without payment. The server answers 402 with a \`${PAYMENT_REQUIRED_HEADER.toUpperCase()}\`
   header (base64 JSON; \`accepts[]\` lists amount in atomic units, asset, payTo, network).
2. Build and sign the USDC transfer described by \`accepts[0]\` with an x402 client.
3. Repeat the request with the signed payload in the \`${PAYMENT_SIGNATURE_HEADERS[0].toUpperCase()}\` header.
4. The facilitator verifies and settles; the server returns 200 with the receipt and a
   \`${PAYMENT_RESPONSE_HEADERS[0].toUpperCase()}\` header.

## Four calls
1. discover: \`GET ${u("/discover")}\` (free)
2. quote: \`GET ${u("/quote")}?txid=<txid>\` (free, validates the txid, no network call)
3. pay: \`GET ${u(PAID_PATH)}?txid=<txid>\` (${cfg.price}, x402)
4. receipt: \`GET ${u("/receipt")}/<hash>\` (free re-read of a receipt already bought)

## Receipt fields
${RECEIPT_FIELDS.map((f) => `\`${f}\``).join(", ")}

## Limits
- Re-reads are served from a process-local cache of the last ${RECEIPT_STORE_CAP} receipts; lost on restart.
- Only confirmed transactions on ${networkName(cfg)} resolve.

## Machine-readable
- OpenAPI: ${u("/openapi.json")}
- Pricing: ${u("/pricing")}
- x402 accepts: ${u("/.well-known/x402")}
`;
}

export function buildLlmsTxt(cfg: ServiceConfig): string {
  const u = (p: string) => url(cfg, p);
  return `# Fluent x402 receipt endpoint

> ${HEADLINE} ${cfg.price} USDC per receipt on ${networkName(cfg)}, paid over x402.

Discovery, quotes and re-reads of receipts already bought are free. Only \`GET ${PAID_PATH}\` is paid.

## Docs

- [agent.md](${u("/agent.md")}): how an agent discovers, quotes, pays and re-reads
- [OpenAPI](${u("/openapi.json")}): every route, including the 402 response schema
- [Discover](${u("/discover")}): capabilities, endpoints, prices and links as JSON

## Optional

- [Pricing](${u("/pricing")}): machine-readable price list
- [x402 accepts](${u("/.well-known/x402")}): mirror of the paid route's payment requirements
- [Status](${u("/status")}): uptime and funnel counters
- [Source](${REPO_URL})
`;
}
