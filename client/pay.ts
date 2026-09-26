// Pays for one receipt with x402 (USDC on Algorand). Used for the mainnet settlement proof.
// Supports both classic 25-word Algorand mnemonics and 24-word BIP39 HD mnemonics (Pera HD wallets).
import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import {
  ExactAvmScheme, ALGOKIT_SIGNER, ALGORAND_MAINNET_GENESIS_HASH, ALGORAND_TESTNET_GENESIS_HASH,
  type ClientAvmSigner,
} from "@x402/avm";
import { ed25519SigningKeyFromWrappedSecret, type WrappedEd25519Secret } from "@algorandfoundation/algokit-utils/crypto";
import { seedFromMnemonic } from "@algorandfoundation/algokit-utils/algo25";
import { generateAddressWithSigners, decodeTransaction } from "@algorandfoundation/algokit-utils/transact";

config();
const mnemonic = process.env.PAYER_MNEMONIC;
if (!mnemonic) throw new Error("Missing PAYER_MNEMONIC");
const base = process.env.SERVER_URL ?? "http://localhost:4021";
const txid = process.argv[2] ?? "BL53UR5MYRZ2XPMN5YATA55YZORMZXYEZI4NNIZTSZ2ERJERBMEQ";
const isMainnet = (process.env.NETWORK ?? "mainnet") === "mainnet";
const network = `algorand:${isMainnet ? ALGORAND_MAINNET_GENESIS_HASH : ALGORAND_TESTNET_GENESIS_HASH}` as `${string}:${string}`;
const hdAccount = Number(process.env.PAYER_HD_ACCOUNT ?? 0);

async function makeSigner(m: string): Promise<ClientAvmSigner> {
  const words = m.trim().split(/\s+/);
  let wrapped: WrappedEd25519Secret;
  let hdPath: { account: number; index: number } | undefined;
  if (words.length === 25) {
    wrapped = { ed25519Seed: async () => new Uint8Array(seedFromMnemonic(m)) };
  } else if (words.length === 24) {
    wrapped = { hdMnemonic: async () => m };
    hdPath = { account: hdAccount, index: 0 };
  } else {
    throw new Error(`mnemonic must be 24 (BIP39 HD) or 25 (Algorand) words, got ${words.length}`);
  }
  const key = await ed25519SigningKeyFromWrappedSecret(wrapped, hdPath);
  const algokit = generateAddressWithSigners({ ed25519Pubkey: key.ed25519Pubkey, rawEd25519Signer: key.rawEd25519Signer });
  const signer: ClientAvmSigner = {
    address: algokit.addr.toString(),
    signTransactions: async (txns, indexesToSign) => Promise.all(txns.map(async (t, i) => {
      if (indexesToSign && !indexesToSign.includes(i)) return null;
      return (await algokit.signer([decodeTransaction(t)], [0]))[0];
    })),
  };
  Object.defineProperty(signer, ALGOKIT_SIGNER, { value: algokit, enumerable: false, writable: false });
  return signer;
}

const signer = await makeSigner(mnemonic);
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
