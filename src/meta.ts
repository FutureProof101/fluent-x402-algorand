import { RECEIPT_FIELDS } from "./receipt.js";
import { GROUP_FIELDS, GROUP_PATH, MEMBER_FIELDS, SAMPLE_GROUP, parseGroupQuery } from "./group.js";
import { RECEIPT_STORE_CAP } from "./store.js";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADERS, PAYMENT_RESPONSE_HEADERS } from "./x402-headers.js";

// Pure builders for the free metadata surface. Everything here is derived from ServiceConfig, the
// same values the paid routes' paymentMiddleware config uses, so /discover, /pricing, /openapi.json
// and /.well-known/x402 cannot disagree with the 402 the server actually issues.

export type ServiceConfig = {
  payTo: string;
  network: `${string}:${string}`;
  usdcAsa: string;
  price: string;
  priceGroup: string;
  publicUrl: string; // "" when unset; links are then relative
  isMainnet: boolean;
};

export const REPO_URL = "https://github.com/FutureProof101/fluent-x402-algorand";
export const SAMPLE_TXID = "BL53UR5MYRZ2XPMN5YATA55YZORMZXYEZI4NNIZTSZ2ERJERBMEQ";
export const TXID_RE = /^[A-Z2-7]{52}$/;
export const TXID_ERROR = "txid must be a 52-char base32 Algorand transaction id";
export const PAID_PATH = "/v1/receipt";

/** A paid route's accepts[] derived from cfg for /.well-known/x402. src/index.ts keeps its own inline
 *  literals; test/meta.test.ts checks the two stay equal. */
export function paidAccepts(cfg: ServiceConfig, path: string = PAID_PATH) {
  const r = PAID_ROUTES.find((x) => x.path === path);
  if (!r) throw new Error(`no paid route ${path}`);
  return [{ scheme: "exact", price: priceOf(cfg, r), network: cfg.network, payTo: cfg.payTo, extra: { asset: cfg.usdcAsa } }];
}

export function networkName(cfg: ServiceConfig): string {
  return cfg.isMainnet ? "algorand-mainnet" : "algorand-testnet";
}

type Param = { name: string; in: "query" | "path"; description: string; pattern?: string; type?: "integer"; required?: false };

/** What a paid route sells. Every free surface reads paid routes through this, never by path. */
type PaidSpec = {
  priceKey: "price" | "priceGroup";
  capability: string;
  resultName: string;
  sample: Record<string, string | number>;
  fields: readonly string[];
  itemFields?: { name: string; fields: readonly string[] };
  result: object; // JSON schema of the 200 body
  badRequest: string;
  notFound: string;
};

export type RouteSpec = {
  method: "GET";
  path: string; // OpenAPI form, e.g. /receipt/{hash}
  free: boolean;
  summary: string;
  contentType: "application/json" | "text/markdown" | "text/plain";
  params?: Param[];
  paid?: PaidSpec;
};

const txidParam: Param = {
  name: "txid", in: "query", description: "Algorand transaction id (base32, 52 chars)", pattern: TXID_RE.source,
};
const groupIdParam: Param = { name: "groupId", in: "query", description: "Atomic group id (standard base64 of 32 bytes; percent-encode it)" };
const roundParam: Param = { name: "round", in: "query", description: "Confirmed round the group landed in", type: "integer" };
const optional = (p: Param): Param => ({ ...p, required: false });

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;
const hashSchema = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;

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
  properties: { receipt: receiptSchema, hash: hashSchema },
};

const memberSchema = {
  type: "object",
  required: [...MEMBER_FIELDS],
  properties: {
    txid: str, type: str, sender: str, receiver: nullableStr, asset: nullableStr, amount: str,
    closeTo: nullableStr, rekeyTo: nullableStr, note: nullableStr,
  },
};

const groupProofSchema = {
  type: "object",
  required: [...GROUP_FIELDS],
  properties: {
    version: { type: "string", const: "fluent-group-proof/1" },
    network: str, groupId: str, round: { type: "integer" },
    complete: { type: "boolean", description: "false when the indexer page was full, so the group may have more members" },
    memberCount: { type: "integer" },
    members: { type: "array", description: "ordered by txid ascending", items: memberSchema },
    indexerSource: str,
  },
};

const groupResultSchema = {
  type: "object",
  required: ["proof", "hash"],
  properties: { proof: groupProofSchema, hash: hashSchema },
};

/** Single route table: registration, /discover, /pricing and /openapi.json all read from this. */
export const ROUTES: readonly RouteSpec[] = [
  { method: "GET", path: "/", free: true, contentType: "application/json", summary: "Service description" },
  { method: "GET", path: "/health", free: true, contentType: "application/json", summary: "Liveness" },
  { method: "GET", path: "/discover", free: true, contentType: "application/json", summary: "What this service sells, prices, endpoints and links" },
  { method: "GET", path: "/quote", free: true, contentType: "application/json", summary: "Price and result shape for a txid, or for a groupId and round, before paying. No network call", params: [txidParam, groupIdParam, roundParam].map(optional) },
  { method: "GET", path: "/receipt/{hash}", free: true, contentType: "application/json", summary: "Re-read a receipt or group proof already bought, by its sha256 hash (process-local cache)", params: [{ name: "hash", in: "path", description: "sha256 hex of the canonical result", pattern: "^[0-9a-f]{64}$" }] },
  { method: "GET", path: "/pricing", free: true, contentType: "application/json", summary: "Machine-readable price list" },
  { method: "GET", path: "/status", free: true, contentType: "application/json", summary: "Uptime and funnel counters" },
  { method: "GET", path: "/openapi.json", free: true, contentType: "application/json", summary: "OpenAPI 3.1 description of every route" },
  { method: "GET", path: "/agent.md", free: true, contentType: "text/markdown", summary: "How an agent buys a receipt" },
  { method: "GET", path: "/llms.txt", free: true, contentType: "text/plain", summary: "llms.txt index" },
  { method: "GET", path: "/.well-known/x402", free: true, contentType: "application/json", summary: "Mirror of the paid routes' x402 accepts[]" },
  {
    method: "GET", path: PAID_PATH, free: false, contentType: "application/json", summary: "Verified Algorand payment receipt with canonical sha256 hash", params: [txidParam],
    paid: {
      priceKey: "price", capability: "algorand-transaction-receipt", resultName: "receipt", sample: { txid: SAMPLE_TXID },
      fields: RECEIPT_FIELDS, result: receiptResultSchema, badRequest: "Malformed txid", notFound: "Transaction not found or not confirmed",
    },
  },
  {
    method: "GET", path: GROUP_PATH, free: false, contentType: "application/json", summary: "Round-pinned Algorand atomic-group proof: members ordered by txid with canonical sha256 hash", params: [groupIdParam, roundParam],
    paid: {
      priceKey: "priceGroup", capability: "algorand-group-proof", resultName: "group proof", sample: { ...SAMPLE_GROUP },
      fields: GROUP_FIELDS, itemFields: { name: "members[]", fields: MEMBER_FIELDS }, result: groupResultSchema,
      badRequest: "Malformed groupId or round", notFound: "No transactions in that group at that round",
    },
  },
];

export const PAID_ROUTES = ROUTES.filter((r): r is RouteSpec & { paid: PaidSpec } => !r.free && r.paid !== undefined);

export function priceOf(cfg: ServiceConfig, r: RouteSpec): string {
  return r.paid ? cfg[r.paid.priceKey] : "$0";
}

/** "txid=<txid>" or "groupId=<groupId>&round=<round>" */
const queryTemplate = (r: RouteSpec) => (r.params ?? []).map((p) => `${p.name}=<${p.name}>`).join("&");
export const paidCall = (r: RouteSpec) => `${r.path}?${queryTemplate(r)}`;

function url(cfg: ServiceConfig, path: string): string {
  return `${cfg.publicUrl}${path}`;
}

function endpoints(cfg: ServiceConfig) {
  return ROUTES.map((r) => ({
    method: r.method,
    path: r.path,
    price: priceOf(cfg, r),
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
    capabilities: [...PAID_ROUTES.map((r) => r.paid.capability), "canonical-sha256-hash", "free-quote", "free-receipt-reread", "x402-exact-usdc"],
    networks: [cfg.network],
    assets: [{ id: cfg.usdcAsa, symbol: "USDC", decimals: 6, network: cfg.network }],
    endpoints: endpoints(cfg),
    sample: Object.assign({}, ...PAID_ROUTES.map((r) => r.paid.sample)) as Record<string, string | number>,
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

export type Quote<B = ReturnType<typeof quoteBody>> =
  | { ok: true; body: B }
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

function groupQuoteBody(cfg: ServiceConfig, groupId: string, round: number) {
  return {
    groupId,
    round,
    price: cfg.priceGroup,
    asset: cfg.usdcAsa,
    payTo: cfg.payTo,
    network: cfg.network,
    willContain: [...GROUP_FIELDS],
    memberFields: [...MEMBER_FIELDS],
    pay: { method: "x402", header: PAYMENT_REQUIRED_HEADER, endpoint: url(cfg, `${GROUP_PATH}?groupId=${encodeURIComponent(groupId)}&round=${round}`) },
  };
}

/** Pure: validates groupId and round and describes what paying would return. Never touches the network. */
export function quoteForGroup(cfg: ServiceConfig, groupId: string, round: string): Quote<ReturnType<typeof groupQuoteBody>> {
  const q = parseGroupQuery(groupId, round);
  if (!q.ok) return q;
  return { ok: true, body: groupQuoteBody(cfg, q.groupId, q.round) };
}

export function buildWellKnown(cfg: ServiceConfig) {
  return {
    x402Version: 2,
    resources: PAID_ROUTES.map((r) => ({
      method: r.method,
      path: r.path,
      resource: url(cfg, r.path),
      mimeType: r.contentType,
      accepts: paidAccepts(cfg, r.path),
    })),
  };
}

export function buildStatus(cfg: ServiceConfig, startedAtMs: number, nowMs: number, counters: Record<string, number>) {
  return { ok: true, network: cfg.network, uptimeSeconds: Math.floor((nowMs - startedAtMs) / 1000), counters };
}

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
  if (r.paid) {
    return {
      "200": { ...json(r.paid.result, `${r.paid.resultName} and canonical hash`), headers: { [PAYMENT_RESPONSE_HEADERS[0].toUpperCase()]: { description: "base64 JSON settlement result", schema: str } } },
      "400": json(errorSchema, r.paid.badRequest),
      "402": { ...json(paymentRequiredSchema, "Payment required"), headers: { [PAYMENT_REQUIRED_HEADER.toUpperCase()]: { description: "base64 JSON PaymentRequired", schema: str } } },
      "404": json(errorSchema, r.paid.notFound),
      "502": json(errorSchema, "Indexer unreachable"),
    };
  }
  if (r.path === "/quote") return { "200": json({ type: "object" }, r.summary), "400": json(errorSchema, "Malformed txid, groupId or round") };
  if (r.path === "/receipt/{hash}") return { "200": json({ oneOf: PAID_ROUTES.map((p) => p.paid.result) }, r.summary), "404": json(errorSchema, "No receipt with that hash") };
  if (r.contentType !== "application/json") return { "200": { description: r.summary, content: { [r.contentType]: { schema: str } } } };
  return { "200": json({ type: "object" }, r.summary) };
}

export function buildOpenApi(cfg: ServiceConfig) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    paths[r.path] = {
      [r.method.toLowerCase()]: {
        summary: r.summary,
        ...(r.params ? { parameters: r.params.map((p) => ({ name: p.name, in: p.in, required: p.required ?? true, description: p.description, schema: { type: p.type ?? "string", ...(p.pattern ? { pattern: p.pattern } : {}) } })) } : {}),
        responses: responsesFor(r),
        ...(r.free ? {} : { "x-x402": { price: priceOf(cfg, r), asset: cfg.usdcAsa, network: cfg.network, payTo: cfg.payTo, scheme: "exact" } }),
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
${PAID_ROUTES.map((r) => `- \`GET ${paidCall(r)}\` (${priceOf(cfg, r)}): ${r.summary}.`).join("\n")}

Each paid result carries the sha256 of its canonical JSON. Paid in USDC (ASA ${cfg.usdcAsa}) to
\`${cfg.payTo}\` on \`${cfg.network}\`.

## How to pay
x402 v2, scheme \`exact\`.
1. Request the paid URL without payment. The server answers 402 with a \`${PAYMENT_REQUIRED_HEADER.toUpperCase()}\`
   header (base64 JSON; \`accepts[]\` lists amount in atomic units, asset, payTo, network).
2. Build and sign the USDC transfer described by \`accepts[0]\` with an x402 client.
3. Repeat the request with the signed payload in the \`${PAYMENT_SIGNATURE_HEADERS[0].toUpperCase()}\` header.
4. The facilitator verifies and settles; the server returns 200 with the result and a
   \`${PAYMENT_RESPONSE_HEADERS[0].toUpperCase()}\` header.

## Four calls
1. discover: \`GET ${u("/discover")}\` (free)
2. quote: ${PAID_ROUTES.map((r) => `\`GET ${u("/quote")}?${paidCall(r).split("?")[1]}\``).join(" or ")} (free, validates the input, no network call)
3. pay: ${PAID_ROUTES.map((r) => `\`GET ${u(paidCall(r))}\` (${priceOf(cfg, r)}, x402)`).join(" or ")}
4. receipt: \`GET ${u("/receipt")}/<hash>\` (free re-read of anything already bought)

## Result fields
${PAID_ROUTES.map((r) => `- ${r.paid.resultName} (\`${r.path}\`): ${r.paid.fields.map((f) => `\`${f}\``).join(", ")}${
    r.paid.itemFields ? `; ${r.paid.itemFields.name}: ${r.paid.itemFields.fields.map((f) => `\`${f}\``).join(", ")}` : ""}`).join("\n")}

## Limits
- Re-reads are served from a process-local cache of the last ${RECEIPT_STORE_CAP} results; lost on restart.
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

> ${HEADLINE} ${PAID_ROUTES.map((r) => `${priceOf(cfg, r)} USDC per ${r.paid.resultName}`).join(", ")} on ${networkName(cfg)}, paid over x402.

Discovery, quotes and re-reads of results already bought are free. Only ${PAID_ROUTES.map((r) => `\`GET ${r.path}\``).join(" and ")} are paid.

## Docs

- [agent.md](${u("/agent.md")}): how an agent discovers, quotes, pays and re-reads
- [OpenAPI](${u("/openapi.json")}): every route, including the 402 response schema
- [Discover](${u("/discover")}): capabilities, endpoints, prices and links as JSON

## Optional

- [Pricing](${u("/pricing")}): machine-readable price list
- [x402 accepts](${u("/.well-known/x402")}): mirror of the paid routes' payment requirements
- [Status](${u("/status")}): uptime and funnel counters
- [Source](${REPO_URL})
`;
}
