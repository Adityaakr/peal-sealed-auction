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

## 2026-11-16, web pages against the testnet (reads only)

| Question | Finding | How |
|---|---|---|
| Do the pages work on the testnet? | Yes. The bid page's committee check passes against the live chain and REST (through the dev server's `/rest` proxy). Member 1 opens its real shares of the demo auction in the browser. The results page shows the settled demo (1.5 fUSD per PEAL-T, 60 and 40 allocated). No page errors | headless Chromium against `?net=testnet`, no transactions sent |
| Page speed over the public RPC | Reading bids one by one was slow enough to show an empty table for seconds. The results and home pages now read in parallel | same |

## 2026-11-16, smart-account bids (joint demo with Peal Bidder)

| Question | Finding | How |
|---|---|---|
| Are EVM logs of `MsgExecuteEVM` (a smart-account call relayed on the native lane) visible to `eth_getLogs`? | **No.** Auction `0x481F…E990` received 2 bids through `MsgExecuteEVM`: `bidCount` is 2, yet `eth_getLogs` shows only the creation and close events. The native tx events carry no EVM logs either | `cast logs`; REST `/cosmos/tx/v1beta1/txs/{hash}` |
| Then where are the envelopes? | Only in the calldata: the `MsgExecuteEVM` body carries `to` and `data` (base64). `readBids` now takes bidder, seq, ct, keyHash and the share hashes from contract storage, and recovers the envelopes from that calldata via the REST tx search (`message.action='/qorechain.abstractaccount.v1.MsgExecuteEVM'`). Envelopes are transport only: each opened share is checked against its on-chain hash | dry run: members 1 and 2 opened both shares |
| How much history does the public node keep? | About 1.4M blocks (lowest height 8,790,799 at 10:07 UTC, head about 10.19M); older ranges fail with "height N is not available, lowest height is M". The log scan now clamps to that height, and is bounded by the auction's age | the failed settle run |
| Can the committee's cards outlive the node's history? | The cards exist only in `MemberJoined` events. They are saved in `deployments/committee-cards.json` (and served to the pages) as an untrusted fallback, checked against the member-signed card hash | `readCommittee(..., fallback)` |
| Block rate | About 0.7 blocks per second (5,483 blocks between 08:00 and 10:10 UTC) | block numbers of known txs |

## 2026-11-16, the hosted app and the browser guest account

| Question | Finding | How |
|---|---|---|
| Can the hosted pages reach REST and the CometBFT RPC? | Only through same-origin paths: neither sends CORS headers. `vercel.json` rewrites exactly the routes in `proxy/allowlist.ts` (PQC routes, balances, account numbers, the tx search) and `/rpc`; `npm run web:preview` serves a build with the same rewrites and headers | `curl` through the preview: `/rest/qorechain/pqc/v1/params` and an RPC `status` answer |
| Does the production CSP (`script-src 'self'`) run the SDK? | It needs `'wasm-unsafe-eval'`: the SDK bundle compiles a WebAssembly hasher (`WebAssembly.compile`). No inline scripts are emitted by the build. With that, account derivation, sealing and native signing ran with no console errors | the guest proof below, under the preview's CSP |
| Can a fresh browser account act on the testnet with no wallet extension? | Yes. A guest from a new 24-word phrase registered its ML-DSA-87 key (`MsgRegisterPQCKeyV2`, classically signed with a proof of possession), opened a window scoped to the faucet for 1 tx and claimed 1,000 PEAL-T, then opened a window scoped to PEAL-T and the auction for 2 txs and sent approve + `commitBid` of a bid sealed in the page | `scripts/testnet/guest-proof.ts`; txs in `deployments/open-demo-0x9A98…c7B4.json` |
| What does a visitor's first bid cost? | 0.513 QOR in total for key registration, two windows, the faucet claim, approve and commit. The windows were spent exactly, so no close fee | guest balance 2 → 1.486607 QOR |
| `createAuction` for the visitors' buyback | 686k gas; approve 46k | `npm run testnet -- create --buyback --demo …` |
| How many bids can the demo auction take? | Capped at 20: settling opens every bid in one `openBids` inside a 3M-gas window transaction, at about 120k gas a bid (286k for 2 on the first run) | design; to confirm at the settle |

## 2026-11-17, kits and the fest's checks

| Question | Finding | How |
|---|---|---|
| How does the fest site decide "Verified"? | Kits: found in the repository's dependency files (and code). Network features: found on chain for one of the project's listed `qor1` addresses (at most five). Everything else shows "Declared". So `qorechain-pqc` was declared while it came in only through the SDK, and the KEM key registry was declared because the listed address was not a committee member | the fest site's form hints and FAQ text, and this project's page |
| Does `@qorechain/pqc` verify the signatures the live `pqcVerify` accepted? | Yes. Both releases of the testnet run (`0xc999a0c2…ee68`, `0xcc039c7d…3007`) verify with `mldsa87.verify` over the 256-byte message rebuilt off chain, against the keys `pqcKeyStatus` returns. Both bids reopen from the stored shares to what the contract recorded | `npm run testnet -- audit 0x9CbA5CFAB2C18a939536CF02906dD543B85Ec124` |
| Does the drawer's QoreX code work against QoreX's real interface? | Yes, through the official mock (`@qorechain/qorex-wallet-mock` 0.1.0, profile "current"), which signs as QoreX does. The mock registered its account's ML-DSA-87 key on its own, then sent 0.01 QOR to the guest; `signAndBroadcast` answered `shield: "shielded"` | tx `1A49EE30…3F3`, `deployments/qorex-proof.json` |
| The mock's address | QoreX derives `m/44'/118'/0'/0/0` on the native lane, so the same phrase gives a different `qor1` address than the SDK's EVM-style derivation (`qor1a43h…998m` against `qor1dhec…dvzx`) | `npm run testnet -- qorex-proof` |
| Does `@qorechain/wallet-adapter` install next to the SDK? | Not as is: its peers ask for cosmjs 0.32 and the SDK uses 0.39 (`ERESOLVE`, as its docs warn). An `overrides` entry that points its two peers at 0.39 installs cleanly | `npm i @qorechain/wallet-adapter@0.6.0` |
| Is the `@handle` registry usable from a page? | Not yet: `@qorechain/handles` needs the registry's base URL and ed25519 key, and neither is published | package README, docs page "Chain bridge and handles" |

## 2026-11-17, evidence and inventory tools

| Question | Finding | How |
|---|---|---|
| What does `qore pq status` say about a key registration? | Tier `enrollment`, not `pqc`: `MsgRegisterPQCKeyV2` is the one classical message, carrying its own proof of possession. Every other native transaction recorded here is tier `pqc` with the ML-DSA-87 layer verified (sign-bytes v2) | `npm run evidence` |
| Can the hash form tell the lane? | No. The guest proof recorded some EVM transactions by their native-style hash; `qore tx get` shows them as `MsgEthereumTx`, tier `classical`. The evidence script classifies by message type | same |
| Does QoreScan see the post-quantum checks in the contracts? | Only with the kit's source included: `PqAuth.sol` is where `pqcVerify` and `pqcKeyStatus` are called. Scanning `src/` alone records only Keccak-256. Locations are file names without directories | `qorescan solidity src lib/qore-pq-kit/src` |
| Do the endpoints negotiate post-quantum TLS? | Yes: both `api-testnet.qore.host` and `evm-testnet.qore.host` answer TLS 1.3 with the hybrid group X25519MLKEM768; their certificates are ECDSA | `npm run cbom` |
| Does the MCP server start from `.mcp.json`? | Yes: `npx qorechain-mcp --network testnet` answers `initialize` and lists read-only tools (no signing tool) | `test-ts/mcp.test.ts` |

## 2026-11-17, the AMM

| Question | Finding | How |
|---|---|---|
| Which pools exist? | Five constant-product pools; pool 2 is fUSD (`erc20:0x9714…63CA`) against `uqor`, about 557 fUSD and 8,149 QOR: 1 fUSD costs about 14.7 QOR. Swap fee 0.30 % of the input, at most 5 % price impact per swap | `GET /qorechain/amm/v1/pools`, `/params` |
| Could an issuer seed a PEAL-T pool at the clearing price? | No: the erc20 module has `permissionless_registration: false`, so PEAL-T cannot become a bank coin, and a pool costs 100 QOR to create | `GET /cosmos/evm/erc20/v1/params`, AMM params |
| Can one transaction swap and convert? | Yes: `MsgSwapExactIn` (floor = the amount wanted) then `MsgConvertCoin` of exactly that amount, hybrid-signed together. The ERC-20 balance grew by exactly the amount; any excess stays as the bank coin | bidder1 `3E4AEEBD…6AED` (+0.2 fUSD); the browser guest from the bid page `6EBF2D96…3E72` (+0.1 fUSD, 1.48 QOR at most) |
| What does the page need from REST? | `/qorechain/amm/v1/pools`, now in `proxy/allowlist.ts` and `vercel.json` | `npm run web:preview` |

## 2026-11-17, MetaMask as a linked key

| Question | Finding | How |
|---|---|---|
| Can a MetaMask key bid in this auction on QoreChain? | Yes, as an authenticator on a post-quantum account. The owner sends `MsgUpdateSpendingRules` and `MsgRegisterAuthenticator` in one hybrid transaction, the second with MetaMask's EIP-191 possession proof. MetaMask then signs each call's EVM-auth digest, and the owner relays them as `MsgExecuteEVM`. The calls run as the owner's 0x address, with no EVM window | bidder1: link `F18C068B…2DA2`, approve + commitBid `8B0B3A1D…46E3` (bid 1 of the open demo) |
| Are the rule's ERC-20 limits enforced? | Yes. With PEAL-T listed as `erc20/0x7eDc…FfE9e` (100 per call), an approve of 5×10¹¹ PEAL-T was refused: "per-tx limit … exceeded … spending limit exceeded". The faucet claim in the same relay executed. Each call has its own outcome in a code-0 transaction | `837DBC8D…5F1B` |
| A call outside `allowed_evm_calls`? | Refused: "a linked key with a spending rule may call 0x9714… with data only if the rule lists the call in allowed_evm_calls (or lists the token as "erc20/0x9714…" for a token transfer or approval)" | approve fUSD to the key itself, `B04CA6CD…145C` |
| Can the committee open such a bid? | Yes: a relayed bid's envelopes come from the `MsgExecuteEVM` calldata (`client/release.ts`). Member 1's dry run opened its share of bid 1 | `readBids` + `openMemberShares`, nothing sent |
| What does a page need from REST? | `/qorechain/abstractaccount/v1/auth_nonce/{account}/{key}` (the key's own sequence), `/cosmos/upgrade/v1beta1/applied_plan/v3.2.3` (which digest the chain verifies), and the account's `spending_rules` and `authenticators`. All four are in `proxy/allowlist.ts` and `vercel.json` | `npm run web:preview` |
| Gas of a relay | Approve + commitBid with three envelopes fit in a 3M-gas native transaction (0.45 QOR fee) | both relays above |
| From the bid page? | Yes, in the production build. The guest linked an injected MetaMask stand-in (EIP-6963 `io.metamask`, `personal_sign` only): 3 prompts, the link proof and two calls. It then relayed approve + commitBid | link `C2914126…9E37`, bid `3F5BAD73…4109` |
| Testing note | A Playwright init script must not read `localStorage` before announcing a provider (it throws in opaque-origin frames). A function compiled by tsx carries `__name` helpers the page lacks, so the stand-in is injected as text | `scripts/testnet/metamask-page-proof.ts` |

## Open questions (to settle on testnet)

- Release gas at larger bid counts (each extra bid adds a share check and a storage write).
