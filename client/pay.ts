// Pays for one receipt with x402 (USDC on Algorand). Used for the mainnet settlement proof.
import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { toClientAvmSigner, ExactAvmScheme, ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import { ed25519SigningKeyFromWrappedSecret, type WrappedEd25519Seed } from "@algorandfoundation/algokit-utils/crypto";
import { seedFromMnemonic } from "@algorandfoundation/algokit-utils/algo25";

config();
const mnemonic = process.env.PAYER_MNEMONIC;
if (!mnemonic) throw new Error("Missing PAYER_MNEMONIC");
const base = process.env.SERVER_URL ?? "http://localhost:4021";
const txid = process.argv[2] ?? "BL53UR5MYRZ2XPMN5YATA55YZORMZXYEZI4NNIZTSZ2ERJERBMEQ";
const network = (process.env.NETWORK ?? "mainnet") === "mainnet" ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2;

async function secretKey(m: string): Promise<string> {
  const seed = seedFromMnemonic(m);
  const wrapped: WrappedEd25519Seed = { ed25519Seed: async () => new Uint8Array(seed) };
  const sk = await ed25519SigningKeyFromWrappedSecret(wrapped);
  return Buffer.concat([Buffer.from(seed), Buffer.from(sk.ed25519Pubkey)]).toString("base64");
}

const signer = toClientAvmSigner(await secretKey(mnemonic));
const client = new x402Client().register(network, new ExactAvmScheme(signer));
console.log("payer:", signer.address);
const paidFetch = wrapFetchWithPayment(fetch, client);
const res = await paidFetch(`${base}/v1/receipt?txid=${txid}`);
console.log("status:", res.status);
if (res.ok) {
  const settle = new x402HTTPClient(client).getPaymentSettleResponse((n) => res.headers.get(n));
  console.log("settlement:", JSON.stringify(settle, null, 2));
}
console.log("body:", JSON.stringify(await res.json(), null, 2));
