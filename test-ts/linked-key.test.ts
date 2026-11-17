/**
 * MetaMask as a linked key (client/linked-key.ts, @qorechain/wallet-adapter):
 * the rule only admits this auction, and the link carries a possession proof
 * the chain's own check accepts. No network.
 */
import { Registry, type GeneratedType } from "@cosmjs/proto-signing";
import { checkValuePermissionRules, qorechainRegistryTypes, validateSpendingRules, verifyAuthenticatorLinkProof } from "@qorechain/sdk";
import { spendingRuleBoundsEveryDenom } from "@qorechain/wallet-adapter";
import { describe, expect, it } from "vitest";
import { getAddress, hexToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bidRule, linkMetaMaskMsgs, revokeMetaMaskMsg, RULE_ID, SELECTORS, type Eip1193 } from "../client/linked-key.ts";

const auction = getAddress("0x9A98Fc3b3B5078Bd22bAE5fb937395Ba1AE8c7B4");
const token = getAddress("0x7edc65adc95de061887ecd6fc8629f2a99fffe9e");
const faucet = getAddress("0xe6c2943ff47e908c8b42af4329fb4abd10452e57");
const owner = "qor1ppnar99nxc8wq4pyjwt029v0ktcel55952jaj3";
const key = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const provider: Eip1193 = {
  async request({ method, params }) {
    if (method !== "personal_sign") throw new Error(method);
    return key.signMessage({ message: { raw: (params as [Hex])[0] } });
  },
};

describe("MetaMask as a linked key", () => {
  const rule = bidRule({ auction, token, faucet, perBid: 100n * 10n ** 18n, daily: 300n * 10n ** 18n });

  it("allows only the faucet claim, the token's approve, and commitBid and claim on this auction", () => {
    expect(rule.id).toBe(RULE_ID);
    expect(rule.allowedEvmCalls).toEqual([
      `${faucet.toLowerCase()}/${SELECTORS.faucetClaim}`,
      `${token.toLowerCase()}/${SELECTORS.approve}`,
      `${auction.toLowerCase()}/${SELECTORS.commitBid}`,
      `${auction.toLowerCase()}/${SELECTORS.claim}`,
    ]);
    expect(SELECTORS.approve).toBe("0x095ea7b3");
    expect(rule.allowedDenoms).toEqual([`erc20/${token}`]);
    expect(rule.denomLimits).toEqual([{ denom: `erc20/${token}`, perTxLimit: (100n * 10n ** 18n).toString(), dailyLimit: (300n * 10n ** 18n).toString() }]);
  });

  it("passes the SDK's and the adapter's checks for a key that moves value", () => {
    expect(() => validateSpendingRules([rule as never])).not.toThrow();
    expect(() => checkValuePermissionRules(["evm"], [rule as never])).not.toThrow();
    expect(spendingRuleBoundsEveryDenom(rule)).toBe(true);
    expect(() => bidRule({ auction, token, perBid: 0n, daily: 1n })).toThrow();
    expect(() => bidRule({ auction, token, perBid: 2n, daily: 1n })).toThrow();
  });

  it("links with a possession proof the chain's own check accepts, rule first, in one encodable transaction", async () => {
    const msgs = await linkMetaMaskMsgs({ provider, address: key.address, owner, chainId: "qorechain-diana", rule, expiryUnix: 1_900_000_000n });
    expect(msgs.map((m) => m.typeUrl)).toEqual(["/qorechain.abstractaccount.v1.MsgUpdateSpendingRules", "/qorechain.abstractaccount.v1.MsgRegisterAuthenticator"]);
    const reg = msgs[1]!.value as { pubkey: Uint8Array; possessionProof: Uint8Array; permissions: string[]; scheme: string };
    expect(reg.scheme).toBe("secp256k1");
    expect(reg.permissions).toEqual(["evm"]);
    expect(verifyAuthenticatorLinkProof({ chainId: "qorechain-diana", account: owner, scheme: "secp256k1", pubkey: reg.pubkey, possessionProof: reg.possessionProof })).toBe(true);
    expect(verifyAuthenticatorLinkProof({ chainId: "qorechain-vladi", account: owner, scheme: "secp256k1", pubkey: reg.pubkey, possessionProof: reg.possessionProof })).toBe(false);
    const registry = new Registry(qorechainRegistryTypes as Iterable<[string, GeneratedType]>);
    for (const m of msgs) expect(registry.encode(m).length).toBeGreaterThan(50);
    expect(revokeMetaMaskMsg(owner, key.address).typeUrl).toBe("/qorechain.abstractaccount.v1.MsgRevokeAuthenticator");
    expect([...(revokeMetaMaskMsg(owner, key.address).value as { pubkey: Uint8Array }).pubkey]).toEqual([...hexToBytes(key.address)]);
  });
});
