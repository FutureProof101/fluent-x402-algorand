# Fluent x402 receipt endpoint (Algorand)

Entry for the Algorand x402 Global Challenge. A paid HTTPS endpoint that turns any confirmed
Algorand transaction into a normalised, hashed **payment receipt** — the record an agent or a
merchant keeps as proof-of-payment. Paid per call in USDC on Algorand mainnet via x402, settled
through the GoPlausible facilitator.

[Fluent](https://withfluent.fi) is a non-custodial billing platform. Its routing model is:
customer pays in the asset they hold, the merchant receives the asset they require, and Fluent
records the receipt. This endpoint is the receipt half of that model exposed as an x402 resource
on Algorand, the platform's first external rail.

## Endpoint

| Route | Price | Notes |
|---|---|---|
| `GET /v1/receipt?txid=<txid>` | $0.01 USDC | x402-gated. Returns the Fluent receipt + sha256 |
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

## Run

```bash
cp .env.template .env   # set PAY_TO
npm install
npm start               # http://localhost:4021
```

Pay for one call (mainnet settlement proof; needs `PAYER_MNEMONIC` in `.env`, never deployed):

```bash
npm run client -- <txid>
```

## Deploy

Any Node 20+ host with HTTPS. Railway: new project from this repo, set `PAY_TO` and
`NETWORK=mainnet`, start command `npm start`. `PORT` is read from the environment.
