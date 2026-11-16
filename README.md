# Peal Sealed Auction

A uniform-price sealed-bid auction on QoreChain whose bids no single key holder can open before the close.

Entry in the QoreChain "Build Before Q-Day" Developer Fest, category **Encrypted Apps**. Licence: Apache-2.0.

> Status (2026-11-16): deployed on the QoreChain testnet (qorechain-diana), with the 2-of-3 committee's ML-DSA-87 joins verified on chain by `pqcVerify` and its ML-KEM-1024 keys registered with `MsgRegisterKEMKey`. The contracts, client, committee daemon and web pages are tested end to end on a local chain and in a headless browser. Deployed addresses will be listed here once they exist.

## The problem

QoreChain's documented recipe for sealed bids encrypts every bid to one auction key. Whoever holds that key can read every bid early. Peal Sealed Auction removes that key holder:

1. The bidder's browser draws a fresh key K for each bid, splits K 2-of-3 with Shamir's scheme, and seals each share with QoreSeal (ML-KEM-1024 + X25519) to a different committee member's ML-KEM key registered on chain.
2. The bid (quantity and price tick) is encrypted under K in one 32-byte block, which the contract can decrypt itself.
3. The ciphertext, a hash of K and a hash of every share go on chain with the escrowed funds. The bid cannot change after this point.
4. After the on-chain close, each committee member opens its own shares in its own browser (or daemon) and posts one release covering every bid, signed with ML-DSA-87 and checked on chain with `pqcVerify`.
5. The contract checks each share against the bidder's hash, rebuilds K from any two shares, checks K, decrypts the bid and computes one clearing price. Bids that cannot open are excluded and refunded; they never fail the auction.

Fewer than two members learn nothing about any bid. There is no reveal step by the bidder, so a bidder has no option to withhold after seeing others.

## Repository layout

| Path | What |
|---|---|
| `src/CommitteeRegistry.sol` | Immutable, content-addressed t-of-n committee sets (n ≤ 7); every member joins with an ML-DSA-87 signature (checked by `pqcVerify`) that binds its ML-KEM key hash and QoreSeal card hash |
| `src/SealedAuction.sol` | One auction (a clone): commit, close, signed releases, on-chain key rebuild and decryption, finalize, pull-based claims |
| `src/SealedAuctionFactory.sol` | Creates, funds and opens an auction in one call; paging |
| `src/demo/PealT.sol`, `src/demo/DemoFaucet.sol` | PEAL-T demo sale token and a rate-limited faucet (testnet only) |
| `client/` | TypeScript client: plaintext codec, committee discovery and checks (`readCommittee`, `resolveCommittee` via the kit's `verifyMember`), bid sealing (`sealBid` via the kit's `sealSlot`), share opening and release signing (`openMemberShares`, `signRelease`), generated ABIs |
| `apps/committee/` | `member.ts` (one member step: release after the on-chain close, optional keeper that opens bids and finalizes) and `daemon.ts` (the member's release daemon) |
| `apps/web/` | Web pages (Vite, plain TypeScript): bidder (seals bids in the browser), committee member (opens shares and signs releases in the browser), results (and the permissionless steps) |
| `proxy/` | Read-only REST proxy for the PQC routes (GET, allowlisted paths only), because the public REST endpoint sends no CORS headers |
| `scripts/local-stack.ts`, `scripts/local/stack.ts` | A long-running local chain for the pages: anvil, precompile stand-ins, contracts, a 2-of-3 committee with real keys, one open auction |
| `scripts/web-smoke.ts` | Drives the pages through a whole auction in headless Chromium (`npm run web:smoke`) |
| `scripts/testnet/` | Testnet operations: accounts (secrets outside the repo), setup (funding, ML-DSA and ML-KEM key registration, fUSD conversion), deploy (contracts and the 2-of-3 committee), demo (a whole auction with the real precompiles, inside scoped windows) |
| `scripts/e2e-local.ts` | The whole auction on anvil with real ML-DSA-87, real QoreSeal and the kit's real `verifyMember` (`npm run e2e:local`) |
| `test-ts/` | Vitest tests of the client with real QoreSeal and ML-DSA-87 |
| `src/libraries/ClearingPrice.sol` | Uniform clearing over at most 256 price ticks; pro-rata at the clearing tick, rounded down |
| `src/libraries/AuctionMath.sol` | Price ladder, escrow (rounded up) and payment (rounded down), fee |
| `test/` | Foundry unit, fuzz and invariant tests on mocked precompiles (the kit's `PqTestBase`) |
| `scripts/window.ts` | QoreChain EVM authorisation window helper, from `create-qorechain-dapp` |
| `docs/spikes.md` | Testnet findings, settled by experiment |
| `THREAT_MODEL.md` | Who can do what, and the residual risks |
| `AI_USAGE.md` | Dated log of how AI agents built this, and what the human decided |

Planned (later pull requests): an issuer page.

The post-quantum building blocks come from the shared toolkit [`qore-pq-kit`](https://github.com/Adityaakr/qore-pq-kit) at tag `v0.1.0`: `PqAuth` (ML-DSA-87 checks through `pqcKeyStatus` and `pqcVerify`), `Shamir` and `SealedSlot` (threshold key shares and the one-block cipher) as a Foundry submodule, and `threshold.ts` as a package.json git dependency.

## Lifecycle

`Created → Funded → CommitOpen → Closed → Settled | Failed | Cancelled`

| Step | Who | What the contract checks |
|---|---|---|
| `createAuction` | issuer | config, committee set exists; supply pulled in full (fee-on-transfer refused) |
| `commitBid(seq, ct, keyHash, shareHashes, envelopes, escrow)` | bidder | `seq` is the bidder's own counter; one share hash and one envelope per member; pulls escrow + bond |
| `closeCommit` | anyone, after `endTime` | freezes the bid set (no bids: Failed) |
| `submitRelease(index, shares, invalidBitmap, deadline, sig)` | anyone relays a member's release | ML-DSA-87 signature by member `index` over the whole frozen set; every share matches its hash; one release per member, before `releaseDeadline` |
| `openBids(ids)` | anyone | any t stored shares rebuild K matching `keyHash`; plaintext padding, tick range, minimum, per-address cap, escrow |
| `finalize` | anyone, once no release can still arrive and every bid is decided | uniform clearing; exact totals of what winners pay |
| `claim`, `claimProceeds`, `claimUnsold` | anyone; funds go to the bidder or the issuer | pull-based, once each |

A bid that cannot open is excluded and refunded; it never fails the auction. The bond is burned only when a bid opens to a malformed plaintext (only the bidder can cause that), or when all n members released and the bid still cannot open. If nobody finalizes within 3 days after the release deadline, anyone can fail the auction and everyone is refunded.

### Gas on mocked precompiles

Measured in the local end-to-end run (anvil). There `pqcVerify` is a cheap stand-in; on testnet each ML-DSA-87 check adds about 313k (design estimate, to be measured).

| Call | Gas on anvil |
|---|---|
| `registerSet` (3 members) | 1.62M, plus 3 `pqcVerify` |
| `commitBid` (3 envelopes of 1,752 bytes) | 383k to 434k |
| `submitRelease` (4 bids) | 456k, plus 1 `pqcVerify` |
| `openBids` (4 bids) | 433k |
| `finalize` | 243k |
| `claim` | 61k to 128k |

## Build and test

Requires [Foundry](https://getfoundry.sh) and Node.js 22.

```sh
git clone --recurse-submodules https://github.com/Adityaakr/peal-sealed-auction
cd peal-sealed-auction
forge test
npm ci && npm run typecheck
```

Tests run on Foundry's local EVM and need no network. Client tests: `npm run test:ts`.

### The whole auction, locally

```sh
npm run e2e:local
```

This starts anvil and runs one auction from start to finish:
- A 2-of-3 committee registers real ML-DSA-87 joins and QoreSeal cards.
- A bidder reads the committee and checks every member with the kit's `verifyMember`. A REST proxy that swaps a member's ML-KEM key is caught.
- Three bidders seal bids with real ML-KEM-1024 + X25519 envelopes, and one more bid is junk.
- After the on-chain close, members 1 and 2 open their shares in their own processes and release. Member 3 stays offline, and a forged release for member 3's slot is refused.
- The contract rebuilds every key and decrypts the bids. A keeper excludes the junk bid and finalizes, and the claims end with the auction holding nothing.

The only stand-ins are the two QoreChain precompiles, which the EVM cannot run. `MockPqcKeyStatus` holds the members' real public keys. `OraclePqcVerify` returns the verdict the harness got by checking each signature with real ML-DSA-87. Both are local only.

### The web pages, locally

```sh
npm run local:stack      # terminal 1: anvil, contracts, committee, one open auction
npm run web              # terminal 2: http://localhost:5173
```

Pick a throwaway account on each page:
- **Bid**: check the committee's keys, then seal and commit. Sealing happens in the browser; the page shows the ciphertext, the three 1,752-byte envelopes and the time it took.
- **Committee**: as member 1 or 2, open your shares in the browser. Each one is a single random number that says nothing about any bid. Then sign the release with ML-DSA-87 and submit it.
- **Results**: close, open, finalize and pay out. These steps are permissionless, and the local chain can skip time.

`npm run web:smoke` does the same in headless Chromium and is part of CI.

For the testnet, run the proxy with `npm run proxy` (or use the dev server's `/rest` route). Pages take `?net=testnet` and read `apps/web/public/config.testnet.json`. Accounts there are dev accounts: a testnet mnemonic pasted into the page, kept in that tab's memory only. That mode is for the demo; there is no public bidding (D8).

### A committee member's daemon

```sh
npm run committee -- --member committee1 --auction 0x... [--keeper]
```

Reads `QORE_MNEMONIC` from `~/.qore-peal-sealed-auction/committee1.env` (mode 0600). The ML-DSA-87 key and the QoreSeal keys both derive from it. The daemon waits for the on-chain close, releases once, and as a keeper opens the bids and finalizes when the release window is over.

## Network

| Network | Cosmos chain id | EVM chain id | EVM RPC |
|---|---|---|---|
| Testnet | `qorechain-diana` | 9800 | `https://evm-testnet.qore.host` |

Every EVM transaction on QoreChain needs a registered ML-DSA-87 key and a live EVM authorisation window; see `scripts/window.ts` (`npm run window status|register|open`). Keys and mnemonics are kept outside the repository and are never committed.

### Deployed (qorechain-diana, EVM chain id 9800)

| Contract | Address |
|---|---|
| `CommitteeRegistry` | `0x95ea32ba3077070a562a9f7ad2e969f231689bae` |
| `SealedAuction` (implementation) | `0xd4a1196aebe17121db3d6c1d56b326575faf62b3` |
| `SealedAuctionFactory` | `0x1160ab95b570a65bbadb488c76e2f8515f3d6562` |
| PEAL-T (demo token) | `0x7edc65adc95de061887ecd6fc8629f2a99fffe9e` |
| PEAL-T faucet (1,000 per day) | `0xe6c2943ff47e908c8b42af4329fb4abd10452e57` |
| fUSD (the fest's token) | `0x97143B771D34ddb9130b807b135Ae675A5a963CA` |

Committee set `0xd6da2884e224c0bff5db99f3b8443e2f7e9e8b5ac1be1786e4a29003fff90fe5`, 2 of 3. Its members are below. The owner holds all three keys as separate accounts; this is disclosed and for the demo only (D3).

| Member | Account | SHA3-256 of its registered ML-KEM-1024 key |
|---|---|---|
| 1 | `0x64eE2394BE93B0e840b06fd497df90E5295786Ee` | `0x602d1000…b4bf0a8d` |
| 2 | `0x75588D0B6117D3C05694B656228508D461A996c4` | `0x13997af9…7fce819e` |
| 3 | `0x0E7db45Da1fD3d974218E59CF8C4387789fF1714` | `0xca620568…b3f0a35b` |

Every transaction hash is recorded in `deployments/qorechain-diana.json`. The pages use the testnet with `?net=testnet`.

### Testnet demo run (2026-11-16)

Auction `0x9CbA5CFAB2C18a939536CF02906dD543B85Ec124` sold 100 PEAL-T for fUSD. Every transaction ran in a scoped window. Every hash is in `deployments/demo-0x9CbA5CFAB2C18a939536CF02906dD543B85Ec124.json`.

| Step | What happened on chain | Gas |
|---|---|---|
| `createAuction` | created, funded with 100 PEAL-T and opened in one call | 684k |
| Committee check | each member's ML-DSA key read from `pqcKeyStatus`, ML-KEM key from `/qorechain/pqc/v1/kem/…` against the signed hash, card verified | (reads) |
| `commitBid` ×2 | 60 PEAL-T at ≤ 2.50 and 70 PEAL-T at ≤ 1.50, each a ciphertext plus three 1,752-byte ML-KEM-1024 + X25519 envelopes | 439k, 405k |
| Forged release | an outsider's ML-DSA-87 signature in member 3's slot, simulated against the live `pqcVerify`: refused (`ReleaseSignatureInvalid`) | none |
| `submitRelease` ×2 | members 1 and 2 opened their shares and released; member 3 stayed offline | 285k each (one real `pqcVerify`) |
| `openBids` | the contract rebuilt each K from two shares, checked it against `keyHash` and decrypted both bids | 286k |
| `finalize` | cleared at 1.50 fUSD per PEAL-T: 60 to bidder 1 (who bid 2.50 and paid 1.50), 40 to bidder 2 | 236k |
| claims | both bidders, proceeds and unsold supply paid out | 40k to 111k |

### Testnet runbook

The project uses six fresh throwaway accounts: a deployer (also the demo issuer), three committee members, and two bidders. The owner holds all three committee keys as separate accounts; this is disclosed and for the demo only (D3). Their mnemonics live in `~/.qore-peal-sealed-auction/<name>.env` (mode 0600).

```sh
npm run testnet -- accounts create   # once; prints addresses only
# fund the deployer from the faucet (dashboard sign-in, an owner step)
npm run testnet -- setup             # split funds, register ML-DSA-87 and ML-KEM-1024 keys, convert fUSD
npm run testnet -- deploy            # contracts + committee; writes deployments/ and the pages' testnet config
npm run testnet -- demo              # one whole auction with the real precompiles
npm run testnet -- accounts status   # balances, keys, windows
npm run testnet -- setup             # again any time: tops accounts up when they run low
```

The pages work on the testnet too. Open the scoped window an account needs (QoreX cannot open windows), then use the page with that account's mnemonic:

```sh
npm run testnet -- window bidder1 0x<auction>      # fUSD + the auction, 2 transactions
npm run testnet -- window committee1 0x<auction>   # the auction, 1 transaction (one release)
npm run web                                         # then open http://localhost:5173/?net=testnet
```

The demo runs every EVM transaction inside a scoped window, so each account can call only the contracts it needs. It records every transaction hash in `deployments/demo-<auction>.json`.

## Prior work

The design and the clearing rules come from the author's own earlier project, **Peal** (private repository, started 6 July 2026, Apache-2.0). Everything in this repository was written during the fest. Rules ported from Peal, rewritten rather than copied:

| Here | Peal source (branch `plan/017-peal-redesign`) |
|---|---|
| `ClearingPrice.sol`: clearing scan, pro-rata allocation, undersubscribed clears at the reserve, no demand fails | `contracts/src/auctionkit/ClearingPrice.sol` and the cases in `contracts/test/auctionkit/ClearingPrice.t.sol` |
| `AuctionMath.sol`: price ladder, escrow rounds up, payment rounds down, fee | `contracts/src/auctionkit/AuctionMath.sol` |
| `CommitteeRegistry`: content addressing, no duplicate members, no impossible thresholds | `contracts/src/auctionkit/CommitteeRegistry.sol` |
| `SealedAuction`: config, fund, open, cancel rules, pull-based claims, fee-on-transfer check | `contracts/src/auctionkit/SealedBidAuction.sol` (lifecycle and claims) |
| `SealedAuctionFactory`: clone, create-fund-open in one call, metadata hash, paging | `contracts/src/auctionkit/AuctionFactory.sol` |
| `DemoFaucet` | `contracts/src/auctionkit/DemoFaucet.sol` |
| Design rules: exclude and never fail; one all-or-nothing signed release per member over the frozen set; bind every seal to its context; release on chain state, not a clock; junk costs a deposit | `docs/plans/017-peal-redesign.md`, section 4 |

What is new here: the whole sealing layer (ML-KEM-1024 share envelopes to registered recipient keys, ML-DSA-bound committee joins, ML-DSA-signed releases, on-chain key reconstruction and decryption). Peal sealed bids with pairing-based threshold encryption on BLS12-381, which is not post-quantum; none of that is used here. Peal's committee reveal root, void and dispute paths are dropped by design.

One rule was deliberately changed while porting. Peal's settlement credits the issuer with the cost of the whole sold supply at the clearing price, rounded down once. Winners are charged their own allocations, each rounded down, which can add up to a few base units less. Here `finalize` sums exactly what each winner pays, so the auction can always pay every refund and the proceeds. A fuzz test checks that both token balances end at exactly zero once everything is claimed.

## Licence

Apache-2.0, see `LICENSE`.
