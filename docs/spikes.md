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

## 2026-11-16, testnet deployment (qorechain-diana)

| Question | Finding | How |
|---|---|---|
| Must an account register its ML-DSA key before a bank send? | We registered first (the one classical message), then sent hybrid. The chain's params say `hybrid_signature_mode: required`, `allow_classical_fallback: false` | `npm run testnet -- setup` |
| Coin order in `MsgSend` | Coins must be sorted by denom: `[uqor, erc20:…]` is refused with `invalid coins` (code 10) and still charges the fee; `[erc20:…, uqor]` works. `setup.ts` sorts them | tx `7A31214D…ABCC` (refused), `834841F6…488A` (accepted) |
| Does `MsgRegisterKEMKey` work from a script? | Yes: SDK `msg.pqc.registerKemKey({ sender, algorithmId: 2, publicKey })`, hybrid-signed; the key is then served at `/qorechain/pqc/v1/kem/{qor1…}` | committee1 tx `1E5640C6…C4DE` |
| fUSD from the faucet | Arrives as the bank coin `erc20:0x9714…63CA`; `MsgConvertCoin` to the bidder's own 0x address makes it the ERC-20 the auction pulls | bidder1 tx `553B8F65…27DC` |
| Deploy gas (real node) | `CommitteeRegistry` 883k, `SealedAuction` implementation 3.72M, factory 767k, PEAL-T 494k, faucet 386k | `deployments/qorechain-diana.json` |
| `registerSet` with 3 real ML-DSA-87 joins | 1.31M gas in total. So `pqcVerify` costs far less than the design's 313k estimate. The anvil figure (1.62M) was higher because the local stand-in reads verdicts from storage | tx `0x470ce18a…b593` |
| Does the registry accept joins made with SDK-derived keys and SDK `pqcSign`? | Yes: `pqcKeyStatus` returned each member's key with possession proven, and all three joins verified on chain | same |

## 2026-11-16, testnet demo run

| Question | Finding | How |
|---|---|---|
| `eth_getLogs` range | The public EVM RPC refuses ranges over 10,000 blocks ("maximum [from, to] blocks distance: 10000"). The client reads logs in chunks, backwards from the latest block, until it has as many events as the contract reports (`client/logs.ts`) | first demo attempt failed at `readCommittee` |
| `submitRelease` gas with the real `pqcVerify` | 285k for a release over 2 bids | demo run |
| `commitBid` gas | 405k to 439k with three envelopes | demo run |
| Is the forged-release refusal real? | `eth_call` of `submitRelease` with an outsider's ML-DSA-87 signature for member 3 reverts `ReleaseSignatureInvalid` against the live precompile | demo run |
| Scoped windows | A window with `allowedTargets` [fUSD, auction] and `maxTxs` 2 admitted exactly approve + commit. A spent window needs no close, which saves a 0.15 QOR fee per account | demo run |
| Cost of one demo run per account | about 0.35 QOR per bidder (window, approve, commit) and 0.33 QOR per member (window, release); the deployer pays the rest. `setup` tops accounts up from the deployer | `npm run testnet -- accounts status` before and after |

## Open questions (to settle on testnet)

- Release gas at larger bid counts (each extra bid adds a share check and a storage write).
