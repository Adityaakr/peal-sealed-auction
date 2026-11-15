/**
 * accounts.ts - create the project's testnet accounts and show their state.
 *
 *   npm run testnet -- accounts create    create any missing secrets files (prints addresses only)
 *   npm run testnet -- accounts status    balances, ML-DSA key, ML-KEM key, EVM window
 */
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { fetchEvmWindow, fetchPqcStatus, isRegisteredPqcKey } from "@qorechain/sdk";
import { balances, FUSD_DENOM, network, publicClient, qor } from "qore-pq-kit";
import { erc20Abi } from "viem";
import { FUSD } from "qore-pq-kit";
import { ACCOUNTS, ensure, load, SECRETS_DIR } from "./lib.ts";

export async function create(): Promise<void> {
  for (const name of ACCOUNTS) {
    const { named, created } = await ensure(name);
    console.log(`${name.padEnd(11)} ${named.evm}  ${named.acc.cosmos}  ${created ? "(created)" : ""}`);
  }
  console.log(`secrets: ${SECRETS_DIR}/<name>.env (0600)`);
}

export async function status(): Promise<void> {
  const net = network();
  for (const name of ACCOUNTS) {
    const n = await load(name);
    const bal = await balances(n.acc.cosmos);
    const fusdErc20 = await publicClient().readContract({ address: FUSD, abi: erc20Abi, functionName: "balanceOf", args: [n.evm] });
    const pqc = await fetchPqcStatus({ rest: net.rest, address: n.acc.cosmos });
    const mine = pqc.registered ? isRegisteredPqcKey(pqc, n.acc.pqc.publicKey) : false;
    const kem = await fetchKemKey({ rest: net.rest, address: n.acc.cosmos });
    const w = await fetchEvmWindow({ rest: net.rest, address: n.acc.cosmos });
    console.log(
      [
        name.padEnd(11),
        n.evm,
        qor(bal.uqor ?? 0n).padEnd(14),
        `fUSD bank ${bal[FUSD_DENOM] ?? 0n} erc20 ${fusdErc20}`,
        `ML-DSA ${pqc.registered ? (mine === false ? "OTHER KEY" : "yes") : "no"}`,
        `ML-KEM ${kem.registered ? "yes" : "no"}`,
        `window ${w.found ? (w.live ? `live (${w.remainingTxs} txs)` : "spent") : "none"}`,
      ].join("  "),
    );
  }
}
