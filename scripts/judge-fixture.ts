/**
 * judge-fixture.ts - the outsider's forged release the judge page sends.
 *
 *   npx tsx scripts/judge-fixture.ts
 *
 * It takes member 1's genuine release of the first open demo from its transaction,
 * rebuilds the exact message member 1 signed, and signs it with a throwaway ML-DSA-87
 * key made here. Only the public key and the signature are written; the secret key is
 * never stored, so the page holds no key at all. The signature is valid under the
 * outsider's key (the page checks that), so the contract can refuse it only because
 * it is not member 1's.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveUnifiedAccount, generateMnemonic, pqcSign } from "@qorechain/sdk";
import { toHex } from "viem";
import { releaseAuthMessage, verifyReleaseSignature } from "../client/audit.ts";
import { JUDGE, loadRelease } from "../client/judge.ts";

const r = await loadRelease({ url: JUDGE.rpc }, JUDGE.openDemo.auction, JUDGE.openDemo.releases[0]!);
const message = releaseAuthMessage({ chainId: BigInt(JUDGE.chainId), auction: r.auction, member: r.from, bidCount: r.shares.length, shares: r.shares, invalidBitmap: r.invalidBitmap, deadline: r.deadline });
const outsider = await deriveUnifiedAccount(generateMnemonic(256), 0);
const signature = pqcSign(outsider.pqc.secretKey, message);
if (!verifyReleaseSignature(outsider.pqc.publicKey, message, signature)) throw new Error("the outsider's own signature does not verify");
const out = join(import.meta.dirname, "..", "client", "judge-forged.ts");
writeFileSync(
  out,
  `/** Written by scripts/judge-fixture.ts: an outsider's ML-DSA-87 signature over member 1's genuine release message. Public values only. */\nimport type { Hex } from "viem";\n\nexport const FORGED: { publicKey: Hex; signature: Hex } = {\n  publicKey: "${toHex(outsider.pqc.publicKey)}",\n  signature: "${toHex(signature)}",\n};\n`,
);
console.log(`wrote ${out}`);
