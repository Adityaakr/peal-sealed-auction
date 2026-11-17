import { deriveUnifiedAccount, generateMnemonic, pqcSign } from "@qorechain/sdk";
import { actionId, authMessage } from "qore-pq-kit";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, getAddress, hexToBytes, keccak256, toBytes, toHex } from "viem";
import { releaseAuthMessage, verifyReleaseSignature } from "../client/audit.ts";
import { signRelease } from "../client/release.ts";

const auction = getAddress("0x1111111111111111111111111111111111111111");
const member = getAddress("0x2222222222222222222222222222222222222222");
const fields = { chainId: 9800n, auction, member, bidCount: 3, shares: [5n, 0n, 7n], invalidBitmap: 2n, deadline: 1_800_000_000n };

describe("release audit", () => {
  it("rebuilds the exact PqAuth message the contract verifies", () => {
    const argsHash = keccak256(
      encodeAbiParameters([{ type: "uint256" }, { type: "uint256[]" }, { type: "uint256" }], [3n, [5n, 0n, 7n], 2n]),
    );
    const kit = authMessage({ chainId: 9800n, verifier: auction, signer: member, action: actionId("SealedAuction.release"), nonce: 0n, deadline: fields.deadline, argsHash });
    const here = releaseAuthMessage(fields);
    expect(here.length).toBe(256);
    expect(toHex(here)).toBe(kit);
    expect(keccak256(toBytes("SealedAuction.release"))).toBe(actionId("SealedAuction.release"));
  });

  it("verifies an SDK ML-DSA-87 signature with @qorechain/pqc, and refuses any change", async () => {
    const acc = await deriveUnifiedAccount(generateMnemonic(256), 0);
    const outsider = await deriveUnifiedAccount(generateMnemonic(256), 0);
    const msg = releaseAuthMessage(fields);
    const sig = hexToBytes(signRelease(acc.pqc, toHex(msg)));
    expect(verifyReleaseSignature(acc.pqc.publicKey, msg, sig)).toBe(true);
    expect(verifyReleaseSignature(outsider.pqc.publicKey, msg, sig)).toBe(false);
    expect(verifyReleaseSignature(acc.pqc.publicKey, releaseAuthMessage({ ...fields, shares: [5n, 0n, 8n] }), sig)).toBe(false);
    expect(verifyReleaseSignature(acc.pqc.publicKey, releaseAuthMessage({ ...fields, deadline: fields.deadline + 1n }), sig)).toBe(false);
    const forged = pqcSign(outsider.pqc.secretKey, msg);
    expect(verifyReleaseSignature(acc.pqc.publicKey, msg, forged)).toBe(false);
    expect(verifyReleaseSignature(acc.pqc.publicKey, msg, sig.slice(1))).toBe(false);
  });
});
