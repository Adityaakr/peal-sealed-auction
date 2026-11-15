# Peal Sealed Auction

A uniform-price sealed-bid auction on QoreChain whose bids no single key holder can open before the close.

Entry in the QoreChain "Build Before Q-Day" Developer Fest, category **Encrypted Apps**. Licence: Apache-2.0.

> Status (2026-11-16): work in progress. The contracts (clearing rule, committee registry, auction lifecycle, factory, demo token and faucet) are written and tested on mocked precompiles. The committee and bidder apps, the local end-to-end run and the testnet deployment follow in later pull requests. Deployed addresses will be listed here once they exist.

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
| `client/abi.ts` | Contract ABIs for the TypeScript apps (`npm run abi`) |
| `src/libraries/ClearingPrice.sol` | Uniform clearing over at most 256 price ticks; pro-rata at the clearing tick, rounded down |
| `src/libraries/AuctionMath.sol` | Price ladder, escrow (rounded up) and payment (rounded down), fee |
| `test/` | Foundry unit, fuzz and invariant tests on mocked precompiles (the kit's `PqTestBase`) |
| `scripts/window.ts` | QoreChain EVM authorisation window helper, from `create-qorechain-dapp` |
| `docs/spikes.md` | Testnet findings, settled by experiment |
| `THREAT_MODEL.md` | Who can do what, and the residual risks |
| `AI_USAGE.md` | Dated log of how AI agents built this, and what the human decided |

Planned (later pull requests): `apps/web` (issuer, bidder and results pages), `apps/committee` (member page and daemon), `proxy/` (read-only REST proxy) and testnet scripts.

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

From `forge test --gas-report`. The mock ML-DSA verifier hashes 4,627-byte signatures in the EVM, so release and join costs here are not testnet costs; `docs/spikes.md` will record the measured testnet numbers.

| Call | Gas (mocked, median) |
|---|---|
| `commitBid` (3 envelopes of 1,752 bytes) | about 300k |
| `openBids` (3 bids) | about 200k |
| `finalize` | about 195k |

## Build and test

Requires [Foundry](https://getfoundry.sh) and Node.js 22.

```sh
git clone --recurse-submodules https://github.com/Adityaakr/peal-sealed-auction
cd peal-sealed-auction
forge test
npm ci && npm run typecheck
```

Tests run on Foundry's local EVM and need no network.

## Network

| Network | Cosmos chain id | EVM chain id | EVM RPC |
|---|---|---|---|
| Testnet | `qorechain-diana` | 9800 | `https://evm-testnet.qore.host` |

Every EVM transaction on QoreChain needs a registered ML-DSA-87 key and a live EVM authorisation window; see `scripts/window.ts` (`npm run window status|register|open`). Keys and mnemonics are kept outside the repository and are never committed.

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
