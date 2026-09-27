import { createHash } from "node:crypto";

export type Receipt = {
  version: "fluent-receipt/1";
  network: string;
  txid: string;
  type: string;
  asset: string | null;
  amount: string;
  from: string;
  to: string | null;
  closeTo: string | null;
  rekeyTo: string | null;
  round: number;
  roundTime: string;
  groupId: string | null;
  note: string | null;
  indexerSource: string;
};

// Runtime copy of the Receipt keys, in canonical order. The two checks below fail to compile if
// this list and the type drift apart in either direction.
export const RECEIPT_FIELDS = [
  "version", "network", "txid", "type", "asset", "amount", "from", "to", "closeTo", "rekeyTo",
  "round", "roundTime", "groupId", "note", "indexerSource",
] as const satisfies readonly (keyof Receipt)[];
const _allFields: Exclude<keyof Receipt, (typeof RECEIPT_FIELDS)[number]> extends never ? true : never = true;
void _allFields;

export type Ok = { receipt: Receipt; hash: string };
type Err = { error: string; status: 404 | 502 };

export async function buildReceipt(indexer: string, txid: string, mainnet: boolean): Promise<Ok | Err> {
  let res: Response;
  try {
    res = await fetch(`${indexer}/v2/transactions/${txid}`, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    return { error: `indexer unreachable: ${(e as Error).message}`, status: 502 };
  }
  if (res.status === 404) return { error: "transaction not found (not confirmed, or wrong network)", status: 404 };
  if (!res.ok) return { error: `indexer returned ${res.status}`, status: 502 };
  const body = (await res.json()) as { transaction?: Record<string, any> };
  const t = body.transaction;
  if (!t || !t["confirmed-round"]) return { error: "transaction not confirmed", status: 404 };

  const ax = t["asset-transfer-transaction"];
  const pay = t["payment-transaction"];
  const receipt: Receipt = {
    version: "fluent-receipt/1",
    network: mainnet ? "algorand-mainnet" : "algorand-testnet",
    txid: t.id,
    type: t["tx-type"],
    asset: ax ? String(ax["asset-id"]) : null,
    amount: String(ax ? ax.amount : pay ? pay.amount : 0),
    from: t.sender,
    to: ax ? ax.receiver : pay ? pay.receiver : null,
    closeTo: ax?.["close-to"] ?? pay?.["close-remainder-to"] ?? null,
    rekeyTo: t["rekey-to"] ?? null,
    round: t["confirmed-round"],
    roundTime: new Date(t["round-time"] * 1000).toISOString(),
    groupId: t.group ?? null,
    note: t.note ?? null,
    indexerSource: new URL(indexer).host,
  };
  // Canonical: fixed key order as declared above, no whitespace.
  const hash = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  return { receipt, hash };
}
