/**
 * qorex-proof.ts - the wallet drawer's QoreX funding path on the real testnet.
 *
 * The page's QoreX module (`apps/web/src/wallet/qorex.ts`, built on
 * `@qorechain/qorex-types`) runs unchanged against QoreChain's official QoreX
 * test double (`@qorechain/qorex-wallet-mock`), which signs exactly as QoreX
 * does: hybrid secp256k1 + ML-DSA-87 through QoreSign, registering the account's
 * ML-DSA-87 key first when it has none. The drawer's "Send from QoreX" then funds
 * a guest account, and QoreX's own `shield` check of the committed transaction
 * must say "shielded".
 *
 *   npm run testnet -- qorex-proof
 *
 * The mock's account is a fresh throwaway testnet phrase in
 * ~/.qore-peal-sealed-auction/qorex-mock.env (mode 0600, never printed). The
 * deployer tops it up with 0.5 QOR when it holds less than 0.3.
 */
import { writeFileSync } from "node:fs";
import { createQorexMock } from "@qorechain/qorex-wallet-mock";
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { balances, broadcast, loadSecrets } from "qore-pq-kit";
import { ensure, load, secretsFile } from "./lib.ts";

export async function qorexProof(): Promise<void> {
  const { created } = await ensure("qorex-mock");
  const mnemonic = loadSecrets(secretsFile("qorex-mock")).QORE_MNEMONIC!;
  if (created) console.log("created the throwaway QoreX-mock account");

  // The mock derives QoreX's own paths (m/44'/118'/0'/0/0 on the native lane), so its address differs from the SDK's.
  const g = globalThis as unknown as { window?: unknown };
  g.window = Object.assign(new EventTarget(), { CustomEvent, location: { origin: "https://peal-sealed-auction.local", hostname: "peal-sealed-auction.local" } });
  const mock = createQorexMock({ profile: "current", mnemonic, autoApprove: true });
  mock.install(g.window as Window);
  const qorexAddr = mock.addresses().native;
  console.log(`QoreX (mock) account ${qorexAddr}`);

  const deployer = await load("deployer");
  const have = (await balances(qorexAddr)).uqor ?? 0n;
  let topUp: string | undefined;
  if (have < 300_000n) {
    const res = await broadcast(deployer.acc, [
      { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: deployer.acc.cosmos, toAddress: qorexAddr, amount: [{ denom: "uqor", amount: "500000" }] } },
    ]);
    topUp = res.transactionHash;
    console.log(`deployer topped it up with 0.5 QOR: tx ${topUp}`);
  }

  const qorex = await import("../../apps/web/src/wallet/qorex.ts");
  if (!qorex.available()) throw new Error("the page's QoreX module did not detect the wallet");
  const acc = await qorex.connect();
  if (acc.cosmos !== qorexAddr) throw new Error(`connect returned ${acc.cosmos}, expected ${qorexAddr}`);
  // The browser guest account of guest-proof.ts (its phrase, as the drawer stores it).
  const visitorPhrase = loadSecrets(secretsFile("visitor")).MNEMONIC;
  if (!visitorPhrase) throw new Error("no MNEMONIC in visitor.env");
  const guest = (await deriveUnifiedAccount(visitorPhrase, 0)).cosmos;
  const sent = await qorex.sendQor(acc.cosmos, guest, 10_000n);
  console.log(`"Send from QoreX" funded guest ${guest} with 0.01 QOR: tx ${sent.txHash}, QoreX shield check: ${sent.shield}`);
  if (sent.shield !== "shielded") throw new Error(`expected a shielded transaction, QoreX says ${sent.shield}`);

  const out = {
    what: "the wallet drawer's QoreX module (qorex-types) funding a guest through the official QoreX mock, hybrid-signed on qorechain-diana",
    date: new Date().toISOString(),
    qorexAccount: qorexAddr,
    guest,
    topUp,
    send: sent.txHash,
    shield: sent.shield,
  };
  writeFileSync("deployments/qorex-proof.json", `${JSON.stringify(out, null, 2)}\n`);
  console.log("wrote deployments/qorex-proof.json");
}
