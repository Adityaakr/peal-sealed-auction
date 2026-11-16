/**
 * evidence.ts - ask the chain, through QoreChain's own read-only CLI
 * (`@qorechain/qore-cli`, command `qore`), about every transaction this
 * repository records in `deployments/`, and about every project account.
 *
 *   npm run evidence                 (testnet; reads only, needs no key)
 *
 * For each native-lane transaction: `qore pq status <hash>` says whether it
 * carries exactly one hybrid layer and whether the ML-DSA-87 signature verifies
 * against the signer's registered key; `qore tx get` gives its messages. For each
 * EVM-lane transaction: `qore tx get` gives success and sender; those carry no
 * ML-DSA-87 layer by design and are admitted by the sender's EVM window. For each
 * account: `qore pq status <qor1…>` gives the registered key, proof of
 * possession and the window.
 *
 * Writes deployments/evidence.json and exits 1 if any native transaction fails
 * its hybrid check or any recorded transaction failed on chain.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const QORE = join("node_modules", ".bin", "qore");
const DIR = "deployments";

async function qore(args: string[]): Promise<Record<string, unknown> | { error: string }> {
  try {
    const { stdout } = await run(QORE, [...args, "--network", "testnet", "--json", "--timeout", "20000"], { maxBuffer: 16 << 20 });
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    try {
      return out ? (JSON.parse(out) as { error: string }) : { error: String(e) };
    } catch {
      return { error: (out ?? String(e)).trim().slice(0, 200) };
    }
  }
}

/** Every recorded transaction hash: values under a "txs"/"nativeTxs" key, or keys named tx/topUp/send. */
function collect(): { file: string; label: string; hash: string }[] {
  const out: { file: string; label: string; hash: string }[] = [];
  const walk = (file: string, v: unknown, path: string[]) => {
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(file, x, [...path, k]);
      return;
    }
    if (typeof v !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(v)) return;
    const last = path[path.length - 1]!;
    if (path.some((p) => p === "txs" || p === "nativeTxs") || ["tx", "topUp", "send"].includes(last)) out.push({ file, label: path.join("."), hash: v });
  };
  for (const f of readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "evidence.json" && f !== "accounts.json").sort()) {
    walk(f, JSON.parse(readFileSync(join(DIR, f), "utf8")), []);
  }
  return out;
}

type Tx = { success?: boolean; messages?: { type_url: string; fields?: Record<string, unknown> }[]; security?: { tier?: string }; height?: string };
type Pq = { transaction_status?: { tier?: string; has_exactly_one_pqc_layer?: boolean; signer?: string; verification?: { verified?: boolean; reason?: string | null } } };
type Addr = { address_status?: { registered?: boolean; algorithm?: string; possession_proven?: boolean; evm_window?: { found?: boolean; live?: boolean; allowed_targets?: string[] } } };

async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const j = i++;
        out[j] = await f(items[j]!);
      }
    }),
  );
  return out;
}

const txs = collect();
let bad = 0;
const rows = await pool(txs, 4, async (t) => {
  const tx = (await qore(["tx", "get", t.hash])) as Tx & { error?: string };
  const row: Record<string, unknown> = { file: t.file, label: t.label, hash: t.hash };
  if ("error" in tx && tx.error) {
    row.error = tx.error;
    return row;
  }
  row.height = tx.height;
  row.success = tx.success;
  row.messages = (tx.messages ?? []).map((m) => m.type_url);
  // The lane is what the transaction carries, not the hash's form: an EVM transaction also has a native-style hash.
  const evm = (row.messages as string[]).every((m) => m.endsWith("MsgEthereumTx"));
  row.lane = evm ? "evm" : "native";
  if (tx.success === false) bad++;
  if (!evm) {
    const pq = (await qore(["pq", "status", t.hash])) as Pq;
    const s = pq.transaction_status;
    row.tier = s?.tier;
    row.hybridLayer = s?.has_exactly_one_pqc_layer;
    row.mlDsa87Verified = s?.verification?.verified;
    row.signer = s?.signer;
    // A key registration is the one classical message on purpose: it carries its own proof of possession.
    row.registration = (row.messages as string[]).some((m) => /MsgRegisterPQCKey/.test(m));
    if (!row.registration && s?.verification?.verified !== true) bad++;
  } else {
    row.tier = tx.security?.tier;
    row.from = tx.messages?.[0]?.fields?.from_address;
  }
  return row;
});

const accounts = JSON.parse(readFileSync(join(DIR, "accounts.json"), "utf8")).accounts as Record<string, { qor: string }>;
const accountRows: Record<string, unknown>[] = [];
for (const [name, a] of Object.entries(accounts)) {
  const s = ((await qore(["pq", "status", a.qor])) as Addr).address_status;
  accountRows.push({ name, qor: a.qor, mlDsa87: s?.registered === true && s.algorithm === "ML-DSA-87", possessionProven: s?.possession_proven, lastWindow: s?.evm_window?.found ? { live: s.evm_window.live, scopedTo: s.evm_window.allowed_targets ?? [] } : null });
}

const byType = new Map<string, number>();
for (const r of rows) for (const m of (r.messages as string[] | undefined) ?? []) byType.set(m, (byType.get(m) ?? 0) + 1);
const unreadable = rows.filter((r) => r.error).length;
const summary = {
  checked: new Date().toISOString(),
  tool: "@qorechain/qore-cli 0.1.1 (qore tx get, qore pq status), testnet",
  transactions: rows.length,
  nativeVerified: rows.filter((r) => r.lane === "native" && r.mlDsa87Verified === true).length,
  native: rows.filter((r) => r.lane === "native" && !r.registration).length,
  keyRegistrations: rows.filter((r) => r.registration).length,
  evmSucceeded: rows.filter((r) => r.lane === "evm" && r.success === true).length,
  evm: rows.filter((r) => r.lane === "evm").length,
  unreadable,
  messageTypes: Object.fromEntries([...byType].sort((a, b) => b[1] - a[1])),
};
writeFileSync(join(DIR, "evidence.json"), `${JSON.stringify({ summary, accounts: accountRows, transactions: rows }, null, 2)}\n`);

for (const r of rows) {
  const verdict = r.error
    ? `unreadable: ${r.error}`
    : r.registration
      ? "key registration (classical, with proof of possession)"
      : r.lane === "native"
        ? `${r.tier}, ML-DSA-87 ${r.mlDsa87Verified ? "verified" : "NOT verified"}`
        : `${r.success ? "succeeded" : "FAILED"}, EVM lane (window)`;
  console.log(`${String(r.label).padEnd(38)} ${String(r.hash).slice(0, 12)}…  ${verdict}  ${((r.messages as string[] | undefined) ?? []).map((m) => m.split(".").pop()).join(", ")}`);
}
for (const a of accountRows) console.log(`account ${String(a.name).padEnd(11)} ${a.qor}  ML-DSA-87 ${a.mlDsa87 ? "registered" : "missing"}, possession ${a.possessionProven ? "proven" : "not proven"}`);
console.log(`\n${summary.nativeVerified} of ${summary.native} native transactions carry a verified ML-DSA-87 layer (plus ${summary.keyRegistrations} key registrations); ${summary.evmSucceeded} of ${summary.evm} EVM transactions succeeded; ${unreadable} unreadable (pruned or not found). Wrote deployments/evidence.json`);
if (bad) {
  console.error(`${bad} transaction(s) failed a check`);
  process.exitCode = 1;
}
