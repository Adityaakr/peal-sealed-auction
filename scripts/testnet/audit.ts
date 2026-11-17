/**
 * audit.ts - an outsider's check of a testnet auction, from public data only
 * (`client/audit.ts`): every release signature verified off chain with
 * `@qorechain/pqc` against the key `pqcKeyStatus` returns, and every bid reopened
 * from the shares the contract stored. Sends nothing; needs no account.
 *
 *   npm run testnet -- audit 0x<auction>
 */
import { publicClient } from "qore-pq-kit";
import type { Address } from "viem";
import { auditAuction } from "../../client/audit.ts";

export async function audit(auction: Address): Promise<void> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(auction ?? "")) throw new Error("usage: npm run testnet -- audit 0x<auction>");
  const r = await auditAuction(publicClient(), auction);
  console.log(`auction ${auction}, chain ${r.chainId}, ${r.threshold} of ${r.members.length}`);
  for (const x of r.releases) {
    const verdict = x.signatureOk === true ? "ML-DSA-87 signature verified here" : x.signatureOk === false ? "SIGNATURE DOES NOT VERIFY" : "not checked";
    console.log(`  release, member ${x.memberIndex} ${x.member}: ${verdict}${x.txHash ? ` (tx ${x.txHash})` : ""}${x.note ? `; ${x.note}` : ""}`);
  }
  for (const b of r.bids) {
    const pt = b.reopened ? `${b.reopened.quantity} at tick ${b.reopened.tick}${b.reopened.padded ? "" : " (bad padding)"}` : "not reopened";
    const verdict = b.agrees === true ? "agrees with the contract" : b.agrees === false ? "DISAGREES WITH THE CONTRACT" : "undecided";
    console.log(`  bid ${b.bidId}: reopened here to ${pt}; ${verdict}${b.note ? `; ${b.note}` : ""}`);
  }
  console.log(r.ok ? "audit passed" : "audit FAILED");
  if (!r.ok) process.exitCode = 1;
}
