# Fluent x402 receipt endpoint (Algorand)

Software buying a proof of payment. An agent or a merchant system hands this endpoint a confirmed
Algorand transaction id and gets back a normalised **payment receipt** with a canonical sha256
hash: the record it keeps as proof that a payment happened. Discovery, quotes and re-reads of a
receipt already bought are free; the receipt itself costs $0.01.

The payment is x402: the paid route answers `402` with its payment requirements, the caller
retries with a signed USDC transfer on Algorand mainnet, and the GoPlausible facilitator verifies
and settles it before the receipt is returned. Entry for the Algorand x402 Global Challenge.

[Fluent](https://withfluent.fi) is a non-custodial billing platform. Its routing model is:
customer pays in the asset they hold, the merchant receives the asset they require, and Fluent
records the receipt. This endpoint is the receipt half of that model exposed as an x402 resource
on Algorand, the platform's first external rail.

## Four calls

```bash
BASE=https://fluent-x402-algorand-production.up.railway.app
TXID=BL53UR5MYRZ2XPMN5YATA55YZORMZXYEZI4NNIZTSZ2ERJERBMEQ

# 1. discover (free): what is sold, prices, endpoints, links
curl -s $BASE/discover

# 2. quote (free, no network call): validates the txid, shows price, payTo and receipt fields
curl -s "$BASE/quote?txid=$TXID"

# 3. pay ($0.01 USDC via x402): unpaid, this answers 402 with a PAYMENT-REQUIRED header;
#    an x402 client signs the transfer and retries with PAYMENT-SIGNATURE
curl -si "$BASE/v1/receipt?txid=$TXID"   # 402 + requirements
npm run client -- $TXID                  # pays and prints the receipt

# 4. receipt (free): re-read a receipt already bought, by its hash
curl -s $BASE/receipt/<hash>
```

## Endpoints

| Route | Price | Notes |
|---|---|---|
| `GET /v1/receipt?txid=<txid>` | $0.01 USDC | x402-gated. Returns the Fluent receipt + sha256 |
| `GET /discover` | free | capabilities, endpoints, prices, links |
| `GET /quote?txid=<txid>` | free | validates the txid; price and receipt shape; no network call |
| `GET /receipt/<hash>` | free | re-read a bought receipt (process-local cache, last 1000, lost on restart) |
| `GET /pricing` | free | machine-readable price list |
| `GET /openapi.json` | free | OpenAPI 3.1, including the 402 response |
| `GET /agent.md` | free | how an agent buys a receipt |
| `GET /llms.txt` | free | [llms.txt](https://llmstxt.org) index |
| `GET /.well-known/x402` | free | mirror of the paid route's `accepts[]` |
| `GET /status` | free | uptime and funnel counters |
| `GET /` | free | service description |
| `GET /health` | free | liveness |

Response:

```json
{
  "receipt": {
    "version": "fluent-receipt/1",
    "network": "algorand-mainnet",
    "txid": "…", "type": "axfer", "asset": "31566704", "amount": "1990000",
    "from": "…", "to": "…", "closeTo": null, "rekeyTo": null,
    "round": 64000000, "roundTime": "…", "groupId": null, "note": null,
    "indexerSource": "mainnet-idx.4160.nodely.dev"
  },
  "hash": "sha256 of the canonical receipt JSON"
}
```

## Design

- **No keys on the server.** `payTo` is a human-owned wallet. Verification and settlement are
  delegated to the facilitator (`HTTPFacilitatorClient`); the server only reads the indexer.
- **Network id form.** The facilitator's `/supported` list advertises Algorand as
  `algorand:<full genesis hash>`, and `@x402/core` matches route networks by exact string, so
  the route uses that form rather than the truncated CAIP-2 constant.
- **Bazaar discovery** declared on the route; tags include `x402-global-challenge`.
- **One source of truth.** `/discover`, `/pricing`, `/openapi.json` and `/.well-known/x402` are
  built from the same route table and config (`src/meta.ts`) that the payment middleware uses.
- **Funnel logging.** The paid route emits one JSON line per event (`402_issued`,
  `payment_presented`, `served`, `payment_failed`) and counts them on `/status`. Payer addresses
  are never logged or exposed; only a count of distinct payers.

## Run

```bash
cp .env.template .env   # set PAY_TO
npm install
npm start               # http://localhost:4021
npm test                # node --test, no network
```

Pay for one call (mainnet settlement proof; needs `PAYER_MNEMONIC` in `.env`, never deployed):

```bash
npm run client -- <txid>
```

## Deploy

Any Node 20+ host with HTTPS. Railway: new project from this repo, set `PAY_TO` and
`NETWORK=mainnet`, start command `npm start`. `PORT` is read from the environment.
