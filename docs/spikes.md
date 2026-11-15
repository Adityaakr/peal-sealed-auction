# Spikes and testnet findings

Testnet facts change quickly and the docs disagree in places, so details are settled by experiment and recorded here with the date and the command that showed them.

## 2026-11-16

| Question | Finding | How |
|---|---|---|
| Does the `create-qorechain-dapp` Foundry template build here? | Yes. `create-qorechain-dapp@0.14.0 --template foundry` scaffolds a Foundry project with `solc 0.8.28` and a window helper (`scripts/window.ts`); the template ships no `.gitignore` and writes a placeholder `.env`, which is not committed | `npx -y create-qorechain-dapp@0.14.0 scaf --template foundry --yes --package-manager npm` |
| Is `qore-pq-kit` tagged yet? | First `v0.1.0-threshold.1` (threshold module only), then `v0.1.0` with `PqAuth`, the precompile mocks and `PqTestBase`. This repository pins `v0.1.0` | `git ls-remote --tags https://github.com/Adityaakr/qore-pq-kit` |
| Does the auction compile without `via_ir`? | No: `commitBid` and `registerSet` take several dynamic calldata arrays and hit "stack too deep". `via_ir = true` (same solc 0.8.28, cancun) | `forge build` |
| npm records the kit's git dependency how? | As `git+ssh://git@github.com/...`; CI rewrites it to https before `npm ci` | `package-lock.json` |

## 2026-11-16, local end-to-end run (anvil)

| Question | Finding | How |
|---|---|---|
| Envelope size per member | 1,752 bytes (hybrid ML-KEM-1024 + X25519, 32-byte share), 5,256 bytes for three members, as designed | `npm run e2e:local` |
| `commitBid` gas | 383k to 434k with three envelopes (calldata and event data dominate) | same |
| `submitRelease` gas | 456k for 4 bids without the real `pqcVerify` | same |
| `registerSet` gas | 1.62M for 3 members without the real `pqcVerify` | same |
| Do QoreSign cards made from SDK-derived keys verify? | Yes: `signRecipientCard` with `classicalKeyFromPrivate(acc.privateKey, "eth_secp256k1")` and `{ secretKey: acc.pqc.secretKey }` passes the kit's `verifyMember` against `acc.pqc.publicKey` | same |

## 2026-11-16, browser and testnet endpoints

| Question | Finding | How |
|---|---|---|
| Does the public EVM RPC allow browser calls? | Yes: preflight answers `access-control-allow-origin: *`, methods `POST`, headers `content-type`; `eth_chainId` returns `0x2648` (9800) | `curl -X OPTIONS -H "Origin: …" https://evm-testnet.qore.host` |
| Does the public REST endpoint allow browser calls? | No CORS headers, so the pages read it through `proxy/` (or the dev server's `/rest`) | `curl -i -H "Origin: …" https://api-testnet.qore.host/qorechain/pqc/v1/params` |
| Is the KEM key route live? | Yes: `/qorechain/pqc/v1/kem/{qor1…}` answers `{"found":false,"key":null}` for an account without a key | through `npm run proxy` |
| Do the SDK, QoreSeal and the kit's `threshold.ts` run in a browser bundle? | Yes, with Vite 6 and target ES2022, no polyfills; about 2.9 MB unminified-equivalent bundle (580 KB gzip). Account derivation, ML-DSA-87 signing, QoreSeal keys and sealing all run in headless Chromium | `npm run web:smoke` |

## Open questions (to settle on testnet)

- Gas of `submitRelease` with one `pqcVerify` and n shares at realistic bid counts.
- Calldata cost of `commitBid` with three 1,752-byte envelopes.
