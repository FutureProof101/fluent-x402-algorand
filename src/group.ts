import { createHash } from "node:crypto";
import { legFromIndexerTx, type Leg } from "./receipt.js";

export type GroupMember = Leg;

export type GroupProof = {
  version: "fluent-group-proof/1";
  network: string;
  groupId: string;
  round: number;
  complete: boolean;
  memberCount: number;
  members: GroupMember[];
  indexerSource: string;
};

// Runtime copies of the proof and member keys, in canonical order. As with RECEIPT_FIELDS, the checks
// below fail to compile if a list and its type drift apart in either direction.
export const GROUP_FIELDS = [
  "version", "network", "groupId", "round", "complete", "memberCount", "members", "indexerSource",
] as const satisfies readonly (keyof GroupProof)[];
const _allGroupFields: Exclude<keyof GroupProof, (typeof GROUP_FIELDS)[number]> extends never ? true : never = true;
void _allGroupFields;

export const MEMBER_FIELDS = [
  "txid", "type", "sender", "receiver", "asset", "amount", "closeTo", "rekeyTo", "note",
] as const satisfies readonly (keyof GroupMember)[];
const _allMemberFields: Exclude<keyof GroupMember, (typeof MEMBER_FIELDS)[number]> extends never ? true : never = true;
void _allMemberFields;

export type GroupOk = { proof: GroupProof; hash: string };
type Err = { error: string; status: 404 | 502 };

/** Page size of the indexer query. A full page means the group may have more members than we saw. */
export const GROUP_LIMIT = 4;
export const GROUP_PATH = "/v1/verify-group";
export const SAMPLE_GROUP = { groupId: "urRYpkY24txRUle6bI6X0ScMP5EJpuk2QJ+P5w46/E8=", round: 64000000 };
export const GROUP_ID_ERROR = "groupId must be standard base64 of exactly 32 bytes";
export const ROUND_ERROR = "round must be a positive integer no greater than 2^53";

// 32 bytes is exactly 44 base64 chars ending in a single "=".
const GROUP_ID_RE = /^[A-Za-z0-9+/]{43}=$/;
const ROUND_RE = /^[1-9][0-9]*$/;

export type GroupQuery = { ok: true; groupId: string; round: number } | { ok: false; status: 400; error: string };

/** Pure: validates groupId and round. An unencoded "+" in a query string arrives as a space; base64
 *  never contains a space, so it is mapped back rather than rejected. */
export function parseGroupQuery(groupIdRaw: string, roundRaw: string): GroupQuery {
  const groupId = groupIdRaw.replace(/ /g, "+");
  if (!GROUP_ID_RE.test(groupId) || Buffer.from(groupId, "base64").length !== 32
    || Buffer.from(groupId, "base64").toString("base64") !== groupId) {
    return { ok: false, status: 400, error: GROUP_ID_ERROR };
  }
  if (!ROUND_RE.test(roundRaw) || BigInt(roundRaw) > 2n ** 53n) return { ok: false, status: 400, error: ROUND_ERROR };
  return { ok: true, groupId, round: Number(roundRaw) };
}

/** Nodely rejects a raw base64 group id, so it is always percent-encoded. */
export function groupQueryUrl(indexer: string, groupId: string, round: number): string {
  return `${indexer}/v2/transactions?group-id=${encodeURIComponent(groupId)}&min-round=${round}&max-round=${round}&limit=${GROUP_LIMIT}`;
}

/** Fetches the group at one round and returns the canonical proof. Callers validate with
 *  parseGroupQuery first; this function only runs on valid input. */
export async function buildGroupProof(indexer: string, groupId: string, round: number, mainnet: boolean): Promise<GroupOk | Err> {
  let res: Response;
  try {
    res = await fetch(groupQueryUrl(indexer, groupId, round), { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    return { error: `indexer unreachable: ${(e as Error).message}`, status: 502 };
  }
  if (res.status === 404) return { error: "no transactions in that group at that round", status: 404 };
  if (!res.ok) return { error: `indexer returned ${res.status}`, status: 502 };
  // current-round and next-token are volatile (next-token is present even on the last page), so
  // only transactions[] is read; completeness comes from the page not being full.
  const body = (await res.json()) as { transactions?: Record<string, any>[] };
  const txs = body.transactions ?? [];
  if (txs.length === 0) return { error: "no transactions in that group at that round", status: 404 };
  if (txs.some((t) => t.group !== groupId || t["confirmed-round"] !== round)) {
    return { error: "indexer returned a transaction outside the requested group and round", status: 502 };
  }

  const members = txs.map(legFromIndexerTx).sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0));
  const proof: GroupProof = {
    version: "fluent-group-proof/1",
    network: mainnet ? "algorand-mainnet" : "algorand-testnet",
    groupId,
    round,
    complete: txs.length < GROUP_LIMIT,
    memberCount: members.length,
    members,
    indexerSource: new URL(indexer).host,
  };
  // Canonical: fixed key order as declared above (members too), no whitespace.
  const hash = createHash("sha256").update(JSON.stringify(proof)).digest("hex");
  return { proof, hash };
}
