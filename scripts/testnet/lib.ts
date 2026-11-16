/**
 * lib.ts - the testnet accounts of this project and helpers around the kit.
 *
 * Secrets live OUTSIDE the repository: ~/.qore-peal-sealed-auction/<name>.env,
 * mode 0600, one BIP-39 mnemonic each (QORE_MNEMONIC). The secp256k1 key, the
 * ML-DSA-87 key and the QoreSeal (ML-KEM-1024 + X25519) keys all derive from it.
 * These are fresh throwaway testnet accounts, separate from every drill account.
 * Nothing here prints a mnemonic or a private key.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { deriveSealKeys, type SealKeyPair } from "@qorechain/qoreseal";
import { deriveUnifiedAccount, generateMnemonic, type UnifiedAccount } from "@qorechain/sdk";
import { loadSecrets, writeSecrets } from "qore-pq-kit";
import { getAddress, type Address } from "viem";

export const SECRETS_DIR = join(homedir(), ".qore-peal-sealed-auction");

/** Who does what (D3: the owner holds all three committee keys, as separate accounts). */
export const ACCOUNTS = ["deployer", "committee1", "committee2", "committee3", "bidder1", "bidder2"] as const;
export type AccountName = (typeof ACCOUNTS)[number];
export const COMMITTEE: AccountName[] = ["committee1", "committee2", "committee3"];
export const BIDDERS: AccountName[] = ["bidder1", "bidder2"];

export const secretsFile = (name: string) => join(SECRETS_DIR, `${name}.env`);

export interface Named {
  name: string;
  acc: UnifiedAccount;
  evm: Address;
  seal: SealKeyPair;
}

export async function load(name: string): Promise<Named> {
  const mnemonic = loadSecrets(secretsFile(name)).QORE_MNEMONIC;
  if (!mnemonic) throw new Error(`QORE_MNEMONIC missing in ${secretsFile(name)}`);
  const acc = await deriveUnifiedAccount(mnemonic, 0);
  return { name, acc, evm: getAddress(acc.evm), seal: deriveSealKeys({ mnemonic }) };
}

/** Create the secrets file for `name` unless it exists. Returns the account either way. */
export async function ensure(name: string): Promise<{ named: Named; created: boolean }> {
  if (existsSync(secretsFile(name))) return { named: await load(name), created: false };
  const mnemonic = generateMnemonic(256);
  const acc = await deriveUnifiedAccount(mnemonic, 0);
  writeSecrets(
    secretsFile(name),
    { QORE_MNEMONIC: mnemonic, EVM_ADDRESS: acc.evm, QOR_ADDRESS: acc.cosmos },
    [
      `Peal Sealed Auction testnet account "${name}", created ${new Date().toISOString()}.`,
      "QORE_MNEMONIC derives the secp256k1, ML-DSA-87 and QoreSeal keys. Throwaway testnet account. Never commit this file.",
    ].join("\n"),
  );
  return { named: await load(name), created: true };
}
