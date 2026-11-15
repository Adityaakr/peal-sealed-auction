/**
 * daemon.ts - a committee member's release daemon.
 *
 *   tsx apps/committee/daemon.ts --member committee1 --auction 0x... [--keeper] [--once]
 *
 * Secrets: ~/.qore-peal-sealed-auction/<member>.env (mode 0600), holding
 * QORE_MNEMONIC. The account's ML-DSA-87 key and its QoreSeal (ML-KEM-1024 +
 * X25519) keys are both derived from it. Nothing here prints a secret.
 *
 * Network: QoreChain testnet by default (QORE_EVM_RPC_URL to override). Every
 * EVM transaction on QoreChain needs a live EVM window for the sending account;
 * open one with the kit's `open-window` before starting.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { deriveSealKeys } from "@qorechain/qoreseal";
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { loadSecrets, sendEvm } from "qore-pq-kit";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { memberStep } from "./member.ts";

const { values } = parseArgs({
  options: {
    member: { type: "string" },
    auction: { type: "string" },
    keeper: { type: "boolean", default: false },
    once: { type: "boolean", default: false },
    interval: { type: "string", default: "15" },
  },
});
if (!values.member || !values.auction) {
  console.error("usage: daemon.ts --member <name> --auction <0x...> [--keeper] [--once] [--interval <secs>]");
  process.exit(2);
}

const secrets = loadSecrets(join(homedir(), ".qore-peal-sealed-auction", `${values.member}.env`));
const mnemonic = secrets.QORE_MNEMONIC;
if (!mnemonic) throw new Error(`QORE_MNEMONIC missing for ${values.member}`);
const acc = await deriveUnifiedAccount(mnemonic, 0);
const seal = deriveSealKeys({ mnemonic });
const rpc = process.env.QORE_EVM_RPC_URL?.trim() || "https://evm-testnet.qore.host";
const client = createPublicClient({ transport: http(rpc) }) as PublicClient;
const send = async (tx: { to: Address; data: Hex }) => (await sendEvm(acc, tx)).transactionHash;

console.log(`member ${acc.evm} watching ${values.auction} on ${rpc}${values.keeper ? " (keeper)" : ""}`);
for (;;) {
  try {
    const r = await memberStep({
      client,
      auction: values.auction as Address,
      me: { address: acc.evm as Address, pqc: acc.pqc, seal },
      send,
      keeper: values.keeper,
      log: (l) => console.log(new Date().toISOString(), l),
    });
    if (r.kind !== "waiting") console.log(new Date().toISOString(), JSON.stringify(r));
    if (r.kind === "terminal" || r.kind === "too-late" || (r.kind === "already-released" && !values.keeper)) break;
  } catch (err) {
    console.error(new Date().toISOString(), err instanceof Error ? err.message : err);
  }
  if (values.once) break;
  await new Promise((res) => setTimeout(res, Number(values.interval) * 1000));
}
