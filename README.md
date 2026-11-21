# Peal Sealed Auction

**A uniform-price sealed-bid auction on QoreChain whose bids no single key holder can open before the close.**

QoreChain "Build Before Q-Day" Developer Fest · category **Encrypted Apps** · live on the QoreChain testnet (`qorechain-diana`) · Apache-2.0

| | |
|---|---|
| **Live site** | <https://peal-sealed-auction.vercel.app> (testnet; the app is at `/auctions.html`) |
| **Open demo auction** | `0x53537D8510AD0567F6E44613257Ae7b513395646` (`qor12dfhmpgs45zk0ahygcfj27h8k5fnj4jx93y0kj`), open for sealed bids until **17 December 2026, 00:00 UTC** |
| **Video** (up to 3 min) | linked on the [project page](https://build.qorechain.io/p/peal-sealed-auction); its source is in [`docs/video/`](docs/video/) |
| **Project page** | <https://build.qorechain.io/p/peal-sealed-auction> |
| **Testnet addresses** | [Live on the testnet](#live-on-the-testnet), with their `qor1` forms |

---

## In one minute

**The problem.** QoreChain's documented recipe for sealed bids encrypts every bid to one auction key. Whoever holds that key can read every bid before the close.

**What this does instead.** Each bid gets its own fresh key K:
- K is split 2-of-3.
- Each share is sealed with ML-KEM-1024 (+ X25519) to a different committee member's key, registered on chain.
- Members can release their shares only after the auction closes on chain, and only with an ML-DSA-87 signature that the contract checks with `pqcVerify`.
- The contract then rebuilds K and decrypts the bids itself.

As a result:
- **No single party can read a bid early**, not the issuer, one member, or the bidder's counterparties. Fewer than two members learn nothing.
- **The bidder cannot back out.** The bid is fixed at commit; there is no reveal step to skip after seeing others.
- **A missing or malicious member cannot sink the auction.** Any two members open every bid. A forged or wrong release reverts. A bid that cannot open is refunded, never fatal.

**It runs on the testnet.** One whole auction ran there end to end with the real precompiles: two sealed bids, a forged release refused by `pqcVerify`, two releases with the third member offline, on-chain decryption, and one clearing price ([run below](#testnet-demo-run-2026-11-16)).

## Try it in 5 minutes

You need a browser and about 1 test QOR. Nothing to install.

1. Open <https://peal-sealed-auction.vercel.app> and press **Try it with a guest account**. *Create a guest account* makes a testnet account in your browser.
2. Fund it with about 1 QOR: the drawer's **Dashboard faucet** button (sign in with your QoreChain account), or one transfer approved in QoreX. Press **Check balance**.
3. Press **Place a sealed bid**. On the bid page, **Check every member's keys** shows three green checks: each member's ML-DSA-87 key from the chain, its ML-KEM-1024 key from the registry, and its signed card.
4. Enter a quantity and a price limit, then **Seal in this browser and commit**. The page claims 1,000 PEAL-T from the demo faucet if you have none, registers your ML-DSA-87 key, opens one EVM window scoped to the three contracts it calls, and commits. It shows your ciphertext and the three 1,752-byte envelopes.
5. **Watch the results**: your bid is listed as yours, still sealed. Nobody, including the committee, can read it before bidding closes on 17 December.

To see what happens after the close, open the [settled testnet run](#testnet-demo-run-2026-11-16) on the results page: add `?auction=0x9CbA5CFAB2C18a939536CF02906dD543B85Ec124` to `/results.html`, and press **Check it in this browser** to verify both releases and reopen both bids yourself (it reads the chain's logs for about half a minute).

A first-time visitor's path was run end to end on 21 November 2026 through the production build with Vercel's headers and rewrites, on a desktop and a phone viewport: a guest created in the page, funded, sent straight to the bid page with no PEAL-T, and committed a sealed bid (faucet claim, approve and `commitBid` in one scoped window) for 0.36 QOR. Every hash is in [`deployments/open-demo-0x53537D…5646.json`](deployments/open-demo-0x53537D8510AD0567F6E44613257Ae7b513395646.json).

## What the site does

The web app opens on a landing page in this product's own identity, the sealed envelope ([`apps/web/DESIGN.md`](apps/web/DESIGN.md)). It shows the open demo auction's sealed slots with their real ciphertexts. Six diagrams answer a visitor's questions in order: the problem, how a bid is sealed, when a bid can be read, why no one opens it early, the live reveal of the testnet run, and the category's requirements with their evidence. From there a visitor can place a real sealed bid in the **open demo auction** (`0x53537D8510AD0567F6E44613257Ae7b513395646`: 50 fUSD for PEAL-T, bidding until 17 December 2026 00:00 UTC, so through judging and the 16 December demo show):

1. **Make a guest account.** *Connect* opens a wallet drawer. A guest account is a fresh testnet key pair made in the browser (secp256k1 and ML-DSA-87, derived by `@qorechain/sdk` from a new 24-word phrase). It lives only in that browser's storage, and it can be backed up and forgotten.
2. **Fund it** with about 1 QOR from the [QoreChain dashboard faucet](https://dashboard.qorechain.io/faucet), or in one transfer approved in QoreX.
3. **Get 1,000 PEAL-T** from the demo faucet with one click.
4. **In a fUSD sale, buy fUSD if you are short.** The bid page quotes the testnet AMM and buys with one hybrid transaction: swap QOR for fUSD, convert it to the ERC-20 the auction pulls (`client/amm.ts`).
5. **Seal and commit a bid.** The bid page checks the committee's keys, seals the bid in the browser and sends `approve` and `commitBid` inside one EVM window scoped to the token and the auction. The guest registers its ML-DSA-87 key first, as QoreChain requires. If the account is short of PEAL-T, the faucet claim joins the same window.

After the close the demo committee releases (`npm run testnet -- settle 0x53537D…5646`), and the results page shows every bid opened, the clearing price, and a *Claim my payout* button.

**Check it yourself.** The results page's *Check it in this browser* button does not trust the contract's verdicts. It reads each member's release from its transaction and rebuilds the signed message itself. It then verifies the ML-DSA-87 signature with `@qorechain/pqc` against the key the chain registered (`pqcKeyStatus`), rebuilds every bid key from the stored shares and decrypts each bid. The same check runs from a terminal: `npm run testnet -- audit 0x9CbA5CFAB2C18a939536CF02906dD543B85Ec124` verifies both releases of the testnet run and reopens both bids (`client/audit.ts`).

**Proven on the testnet** through the production build, with the same headers and rewrites as Vercel: in the first demo auction (`scripts/testnet/guest-proof.ts`, `deployments/open-demo-0x9A98Fc3b3B5078Bd22bAE5fb937395Ba1AE8c7B4.json`), and again in the current one from a guest created in the page (above).

**The three ways in**, and what each can really do on QoreChain today:

| Wallet | What it does here | What it cannot do |
|---|---|---|
| Guest account (browser) | Bids, claims and runs the permissionless steps. It registers its ML-DSA-87 key, opens a window scoped to the exact contracts and transaction count, sends, and closes the window if anything is left of it | Hold real funds: testnet only, and the page says so |
| QoreX | Identifies the visitor and funds the guest with one `MsgSend` approved in QoreX, through the official `@qorechain/qorex-types`. QoreX's own check that the committed transfer carries the ML-DSA-87 layer is shown, and a `downgraded` one is refused. The path ran on the testnet through the official QoreX mock (`npm run testnet -- qorex-proof`, `deployments/qorex-proof.json`) | Send EVM transactions for pages ("not yet supported" in its docs) |
| MetaMask | Connects, adds the QoreChain testnet network, and **bids through the guest account** (`@qorechain/wallet-adapter`). The guest links MetaMask once as an authenticator under an on-chain spending rule: this auction, its token and the demo faucet only, capped per call and per day, for 24 hours. MetaMask signs each call and the guest relays it as `MsgExecuteEVM`, with no window (`client/linked-key.ts`; `deployments/metamask-proof.json`) | Sign for QoreChain by itself: an EVM transaction needs an ML-DSA-87 key and a window, which MetaMask cannot make |

Committee members and issuers keep using their own accounts and the CLI; the demo committee never types its keys into the hosted page.

## How it works

```
 Bidder's browser                         Chain (SealedAuction)                       Committee member j (own browser or daemon)
 ─────────────────                        ─────────────────────                       ──────────────────────────────────────────
 K ← random in F_P (P = 2^255 − 19)
 ct = (qty ‖ tick ‖ 0…) XOR keccak(…, K)
 s_1, s_2, s_3 = Shamir 2-of-3 of K
 E_j = QoreSeal(s_j → member j's ML-KEM key)
 commitBid(ct, H(K), H(s_1..3), E_1..3) ──▶ stores ct, H(K), H(s_j); emits E_j;
                                           pulls escrow + bond
                                          closeCommit  (bid set frozen)
                                                                                      opens E_j with its ML-KEM key, checks H(s_j)
                                          submitRelease(j, shares, sig) ◀──────────── signs one release over ALL bids (ML-DSA-87)
                                           pqcVerify(sig) ✓; every share matches H(s_j)
                                          openBids: any 2 shares → K; H(K) ✓; decrypt
                                          finalize: one uniform clearing price
                                          claim: tokens + refunds, pull-based
```

Every hash and every envelope is bound to the chain id, the auction, the bidder and the bidder's own bid counter, so nothing can be replayed elsewhere. The hashes, the cipher and the Shamir code come from the shared toolkit [`qore-pq-kit`](https://github.com/Adityaakr/qore-pq-kit) (`SealedSlot`, `Shamir`, `PqAuth`, `threshold.ts`).

## The category's requirements, with evidence

| Requirement | How it is met | Code and tests | On the testnet |
|---|---|---|---|
| **ML-KEM-1024 encryption** | Every key share is a QoreSeal hybrid envelope (ML-KEM-1024 + X25519) to one member, 1,752 bytes each | `client/bid.ts` (kit `sealSlot`); `test-ts/client.test.ts`: an outsider opens nothing; an envelope copied to another bidder or seq fails its AAD | commits `0x5f6bde8f…4584`, `0x669cf22f…4f1b` carry 3 envelopes each |
| **Registered recipient keys** | Members publish ML-KEM keys with `MsgRegisterKEMKey`. Bidders read them from `/qorechain/pqc/v1/kem/{addr}` and accept them only if the SHA3-256 matches the hash the member signed into the registry | `scripts/testnet/setup.ts`; `client/committee.ts` (kit `verifyMember`); `e2e-local`: a REST proxy swapping a key is caught | `MsgRegisterKEMKey` txs `1E5640C6…C4DE`, `C8BE6A24…4858`, `8E451CFD…D93A` |
| **ML-DSA key binding** | Each member's join is an ML-DSA-87 signature (`pqcVerify`, key from `pqcKeyStatus`) binding its ML-KEM key hash and QoreSeal card hash to the set. Releases are ML-DSA-87 signed and verified on chain | `src/CommitteeRegistry.sol`, `src/SealedAuction.sol` (kit `PqAuth`); 16 registry tests and 14 release-refusal tests | `registerSet` `0x470ce18a…b593` (3 joins verified); releases `0xc999a0c2…ee68`, `0xcc039c7d…3007`; forged release refused |
| **Client-side encryption and decryption** | Bids are sealed in the bidder's browser. Each member opens its shares and signs its release in its own browser, and keys never leave the tab | `apps/web/` (bid and committee pages); `npm run web:smoke` drives a whole auction in headless Chromium in CI | the same pages work against the testnet (`?net=testnet`) |

Every testnet hash is listed in [`deployments/`](deployments/). `npm run evidence` re-checks all of them on the chain with QoreChain's `qore` CLI: every native transaction's ML-DSA-87 layer, and every EVM transaction's outcome (`deployments/evidence.json`). `npm run cbom` writes the project's crypto inventory with QoreScan (`docs/qorescan/`).

## Live on the testnet

`qorechain-diana`, EVM chain id 9800, RPC `https://evm-testnet.qore.host`.

| Contract | Address | Native (`qor1`) form |
|---|---|---|
| `CommitteeRegistry` | `0x95ea32ba3077070a562a9f7ad2e969f231689bae` | `qor1jh4r9w3swurs5432naad96tf7gck3xawg5j7fu` |
| `SealedAuction` (implementation) | `0xd4a1196aebe17121db3d6c1d56b326575faf62b3` | `qor16js3j6htu9cjrkeadsw4dvex2a067c4nke5qvn` |
| `SealedAuctionFactory` | `0x1160ab95b570a65bbadb488c76e2f8515f3d6562` | `qor1z9s2h9d4wzn9hwkmfzx8dchc290n6etzdq0pk7` |
| Open demo auction (until 17 Dec 2026) | `0x53537D8510AD0567F6E44613257Ae7b513395646` | `qor12dfhmpgs45zk0ahygcfj27h8k5fnj4jx93y0kj` |
| Testnet demo run (settled) | `0x9CbA5CFAB2C18a939536CF02906dD543B85Ec124` | `qor1nja9e74jcx9f89fkeupfqmw4gwu9asfyu4xp8a` |
| PEAL-T (demo token) | `0x7edc65adc95de061887ecd6fc8629f2a99fffe9e` | `qor10mwxttwfthsxrzr7e4husc5l92vlll57lceqlk` |
| PEAL-T faucet (1,000 per day) | `0xe6c2943ff47e908c8b42af4329fb4abd10452e57` | `qor1umpfg0l506ggez6z4apjn762h5gy2tjhgx37gg` |
| fUSD (the fest's token) | `0x97143B771D34ddb9130b807b135Ae675A5a963CA` | |

| Account | Address | Native (`qor1`) form |
|---|---|---|
| Deployer and demo issuer | `0xC9Ec3F3Af272d4b18917fba0E5C63E4056d9Be40` | `qor1e8kr7whjwt2trzghlwswt337gptdn0jqz33zrh` |
| Committee member 1 | `0x64eE2394BE93B0e840b06fd497df90E5295786Ee` | `qor1vnhz8997jwcwss9sdl2f0husu5540phwjx0pdx` |
| Committee member 2 | `0x75588D0B6117D3C05694B656228508D461A996c4` | `qor1w4vg6zmpzlfuq455ketz9pgg63s6n9ky76zt0v` |
| Committee member 3 | `0x0E7db45Da1fD3d974218E59CF8C4387789fF1714` | `qor1pe7mghdpl57ewsscukw033pcw7yl79c5z7aygx` |

Open demo auction for visitors: `0x53537D8510AD0567F6E44613257Ae7b513395646` (a buyback: 50 fUSD for PEAL-T, limits 0.50 to 2.25 PEAL-T per fUSD, bond 1 PEAL-T, at most 32 bids, bidding until 17 December 2026 00:00 UTC, releases until 18 December), opened with `npm run testnet -- create --buyback --demo --until 2026-12-17T00:00:00Z --release-seconds 86400 --max-bids 32`; transactions in `deployments/open-demo-0x53537D8510AD0567F6E44613257Ae7b513395646.json`. The first demo auction, `0x9A98Fc3b3B5078Bd22bAE5fb937395Ba1AE8c7B4`, took bids until 23 November.

Committee set `0xd6da2884e224c0bff5db99f3b8443e2f7e9e8b5ac1be1786e4a29003fff90fe5`, 2 of 3. In the demo the owner holds all three member keys as separate accounts; this is disclosed and for the demo only.

| Member | Account | SHA3-256 of its registered ML-KEM-1024 key |
|---|---|---|
| 1 | `0x64eE2394BE93B0e840b06fd497df90E5295786Ee` | `0x602d1000…b4bf0a8d` |
| 2 | `0x75588D0B6117D3C05694B656228508D461A996c4` | `0x13997af9…7fce819e` |
| 3 | `0x0E7db45Da1fD3d974218E59CF8C4387789fF1714` | `0xca620568…b3f0a35b` |

### Testnet demo run (2026-11-16)

Auction `0x9CbA5CFAB2C18a939536CF02906dD543B85Ec124` sold 100 PEAL-T for fUSD. Every EVM transaction ran in a *scoped* window, so each account could call only the contracts it needed. All hashes are in `deployments/demo-0x9CbA5CFAB2C18a939536CF02906dD543B85Ec124.json`.

| Step | What happened on chain | Gas |
|---|---|---|
| `createAuction` | created, funded with 100 PEAL-T and opened in one call | 684k |
| Committee check | each member's ML-DSA key from `pqcKeyStatus`, ML-KEM key from REST against the signed hash, card verified | reads |
| `commitBid` ×2 | 60 PEAL-T at ≤ 2.50 and 70 PEAL-T at ≤ 1.50, each a ciphertext plus three 1,752-byte envelopes | 439k, 405k |
| Forged release | an outsider's ML-DSA-87 signature in member 3's slot, simulated against the live `pqcVerify`: refused, `ReleaseSignatureInvalid` | none |
| `submitRelease` ×2 | members 1 and 2 opened their shares and released; member 3 stayed offline | 285k each |
| `openBids` | the contract rebuilt each K from two shares, checked it against `keyHash` and decrypted both bids | 286k |
| `finalize` | cleared at 1.50 fUSD per PEAL-T: 60 to bidder 1 (bid 2.50, paid 1.50), 40 to bidder 2 | 236k |
| claims | both bidders, the proceeds and the unsold supply paid out | 40k to 111k |

## Try it

Requires [Foundry](https://getfoundry.sh), Node.js 22 and, for the browser run, a Chromium.

```sh
git clone --recurse-submodules https://github.com/Adityaakr/peal-sealed-auction
cd peal-sealed-auction
npm ci
forge test            # 111 Solidity tests: unit, fuzz, invariants
npm run test:ts       # client tests with real QoreSeal and ML-DSA-87
npm run e2e:local     # a whole auction on anvil
npm run web:smoke     # the landing page, a guest account's bid, then a whole auction, in headless Chromium
```

**The whole auction, locally** (`npm run e2e:local`). It uses real ML-DSA-87 keys and signatures, real QoreSeal envelopes, and the kit's real `verifyMember`. It checks:
- a REST proxy that swaps a member's key is caught;
- a junk bid is excluded without failing the auction;
- a forged release is refused;
- member 3 offline does not stop the opening;
- finalizing early is refused;
- the auction ends holding nothing.

The EVM cannot run QoreChain's precompiles, so locally two stand-ins replace them. `MockPqcKeyStatus` holds the real public keys. `OraclePqcVerify` returns the verdict of real ML-DSA-87 verification done by the harness. Both are local only.

**The web pages, locally:**

```sh
npm run local:stack   # terminal 1: anvil, contracts, committee, a sale and an open demo buyback, throwaway accounts
npm run web           # terminal 2: http://localhost:5173 (the landing page; the app is at /auctions.html)
```

Served from this machine, the pages use the local stack's config when it exists and the testnet otherwise; `?net=local` or `?net=testnet` chooses. On the local node the wallet drawer's guest account gets test QOR with one click.

The pages:
- **Landing** (`/`): the mechanism, live figures, the evidence, and a guided first bid.
- **Auctions:** every auction, newest first, with the open demo pinned on top.
- **Issue:** open a sale, or a buyback (fUSD for PEAL-T).
- **Bid:** check the committee's keys, then seal and commit in the browser, with the guest account or a dev account.
- **Committee:** open your own shares in the browser (each is one random number), then sign and submit the release.
- **Results:** close, open, finalize and pay out, all permissionless; *Claim my payout* for the account in use.

**On the testnet** (six fresh throwaway accounts; mnemonics in `~/.qore-peal-sealed-auction/<name>.env`, mode 0600, never in the repository):

```sh
npm run testnet -- accounts create            # once; prints addresses only
npm run testnet -- setup                      # top up from the deployer; register ML-DSA-87 and ML-KEM-1024 keys; convert fUSD
npm run testnet -- deploy                     # idempotent; writes deployments/ and the pages' testnet config
npm run testnet -- demo                       # one whole auction with the real precompiles
npm run testnet -- create [--ticks 48]        # only open an auction (for the pages, another entry, or a recording)
npm run testnet -- settle 0x<auction>         # after the close: members 1 and 2 release, open, finalize
npm run testnet -- window bidder1 0x<auction> # a scoped window for using the pages (QoreX cannot open windows)
npm run testnet -- accounts status            # balances, keys, windows
npm run web                                   # then http://localhost:5173/?net=testnet
```

**A committee member's daemon:** `npm run committee -- --member committee1 --auction 0x… [--keeper]`. It waits for the on-chain close, releases once, and as a keeper opens the bids and finalizes when no release can still arrive.

## Hosting on Vercel

The repository is ready to import in Vercel as it is: `vercel.json` holds everything, and no environment variables or secrets are needed. Vercel's free tier is enough. A clean clone builds with exactly these commands (checked on 21 November 2026).

1. In Vercel, *Add New… → Project*, and import `Adityaakr/peal-sealed-auction` from GitHub.
2. Keep the project name `peal-sealed-auction`, so the site is <https://peal-sealed-auction.vercel.app>. Leave *Framework Preset* on *Other*, *Root Directory* on `./`, and the build and output settings untouched: `vercel.json` sets them. No environment variables.
3. *Deploy*. The site opens on the landing page, on the testnet. Every push to `main` redeploys it.

What `vercel.json` does:
- **Build:** `npm ci` (with the git-over-https rewrite the toolkit dependency needs), then `npm run web:build`; it serves `apps/web/dist`.
- **Rewrites:** QoreChain's REST API and CometBFT RPC send no CORS headers, so the pages reach them through same-origin paths. `/rest/…` forwards only the routes the pages read (the PQC key, account and window routes, balances, account numbers, and the transaction search), the same list as `proxy/allowlist.ts`. `/rpc` forwards to the CometBFT RPC, which the guest account uses to broadcast its hybrid-signed messages. The EVM RPC allows browsers directly. Nothing is forwarded anywhere else, and the proxy holds no keys.
- **Headers:** a Content-Security-Policy that allows scripts only from the site (plus `'wasm-unsafe-eval'`, because the SDK compiles a WebAssembly hasher; it does not allow `eval`), fonts from Fontshare and Google Fonts, and connections only to the site and the EVM RPC. Framing is refused.

To check a build the way Vercel serves it, with the same headers and rewrites: `npm run web:build && npm run web:preview`, then <http://localhost:4173/?net=testnet>.

To point the hosted site at a new demo auction: `npm run testnet -- create --buyback --demo --until <UTC time> --release-seconds 86400 --max-bids 32`, commit the updated `apps/web/public/config.testnet.json`, and Vercel redeploys.

## A sealed bond issue only post-quantum accounts can hold

Bonds are issued by uniform-price sealed auction. PEAL-B (`src/demo/PealBond.sol`) is a demo bond that only an account with a registered ML-DSA-87 key may hold. The check is QoreChain's Asset Kit `QoreChainHybridHolderGuard`, used unchanged from `lib/qorechain-asset-kit` (`v0.1.0`), which reads `pqcKeyStatus` and fails closed. The venue's factory and its auctions are admitted, because a contract cannot hold a key. So an allocation can only land where a stolen classical key alone cannot move it.

`npm run testnet -- bond` ran it on 16 and 17 November (`deployments/bond-demo.json`):
- 100 PEAL-B were sold for fUSD.
- Two sealed bids were opened by members 1 and 2. The issue cleared at 1.50 fUSD, and 30 and 70 PEAL-B were paid out through the guard.
- A transfer to an address without a key reverts `NotEligible`.

Guard `0x13c978322103fc9b78f622999053cb458d893303`, PEAL-B `0xa796bc03cac5e3bb5c099f0a38fd0cc81e0a0aab`, issue `0xd919F252cD684AF3822DF42F160BAeDf61DCDF68`.

## The rules the contract enforces

`Created → Funded → CommitOpen → Closed → Settled | Failed | Cancelled`

| Step | Who | What the contract checks |
|---|---|---|
| `createAuction` | issuer | config valid, committee set exists; supply pulled in full (fee-on-transfer refused) |
| `commitBid(seq, ct, keyHash, shareHashes, envelopes, escrow)` | bidder | `seq` is the bidder's own counter; one hash and one envelope per member; pulls escrow + bond |
| `closeCommit` | anyone, after `endTime` | freezes the bid set (no bids: Failed) |
| `submitRelease(index, shares, invalidBitmap, deadline, sig)` | anyone relays a member's release | ML-DSA-87 signature by member `index` over the whole frozen set; every share matches its hash and is in the field; once per member; before `releaseDeadline` |
| `openBids(ids)` | anyone | some 2 stored shares rebuild K matching `keyHash`; plaintext padding, tick range, minimum, per-address cap, escrow covers the bid |
| `finalize` | anyone, once no release can still arrive and every bid is decided | uniform clearing; exact totals of what winners pay |
| `claim`, `claimProceeds`, `claimUnsold` | anyone; funds go to the bidder or the issuer | pull-based, once each |

- **Exclude, never fail.** A bid that cannot open is excluded and refunded.
- **The bond burns only when the fault is clear:**
  - the bid opens to a malformed plaintext, which only the bidder can cause;
  - or all members released and the bid still cannot open.
- **Liveness.** If nobody finalizes within 3 days after the release deadline, anyone can fail the auction and refund everyone.
- **Clearing.** Uniform price over at most 256 ticks, pro rata at the clearing tick. Escrow rounds up and payment rounds down. An undersubscribed auction clears at the reserve.

**Buyback.** A treasury buyback is the same auction with fUSD as the sale token. A bid of "at most X PEAL-T per fUSD" is an offer of PEAL-T at "at least 1/X fUSD each", so one forward clearing rule serves both. The pages show the price both ways.

What is protected, against whom, and what is not: [`THREAT_MODEL.md`](THREAT_MODEL.md).

## Honest limits

- **The demo committee is one person.** The owner holds all three member keys, as three separate accounts. The protocol is built for three independent members; the demo shows the mechanism, not the independence.
- **Releases are run by the owner after the close.** Members release from their own committee page or with `npm run committee`, not from the hosted site's guest account. The open demo auction is settled with `npm run testnet -- settle 0x53537D…5646` after 17 December.
- **A visitor needs about 1 test QOR first.** The dashboard faucet asks the visitor to sign in, and QoreX can fund a guest in one transfer. The site has no faucet of its own for QOR, only for PEAL-T.
- **QoreX cannot send EVM transactions for pages yet**, so it funds the guest account rather than bidding itself; MetaMask bids only through the guest's spending rule.
- **Bidder privacy ends at the clearing.** Bids are sealed until the close; after the opening every bid is public on chain, as in any sealed-bid auction that settles on chain.
- **QoreSeal is version 0.1.0**, published as a draft pending an external review.
- **The open demo takes at most 32 bids**, so settlement stays inside one window per chunk of bids; the landing page draws the first 20 slots.

## Repository

| Path | What |
|---|---|
| `src/CommitteeRegistry.sol` | Immutable, content-addressed t-of-n committee sets (n ≤ 7) with ML-DSA-87 joins |
| `src/SealedAuction.sol` | One auction (a clone): commit, close, signed releases, on-chain key rebuild and decryption, finalize, claims |
| `src/SealedAuctionFactory.sol` | Create, fund and open in one call; paging |
| `src/libraries/` | `ClearingPrice` (uniform clearing) and `AuctionMath` (price ladder, escrow and payment rounding, fee) |
| `src/demo/` | PEAL-T demo token, a rate-limited faucet, and PEAL-B, a bond only post-quantum accounts may hold (Asset Kit guard) |
| `client/` | TypeScript client: committee discovery and checks, bid sealing, share opening, release signing, chunked log reads, ABIs |
| `apps/web/` | Landing page, and the auctions, issuer, bidder, committee and results pages (Vite, plain TypeScript, the shared Peal design language) |
| `apps/web/src/wallet/` | The wallet drawer: guest account, QoreX, MetaMask |
| `apps/web/DESIGN.md`, `apps/web/src/landing*` | The landing page's identity and its diagrams |
| `vercel.json`, `scripts/web-preview.ts` | Hosting on Vercel, and a local preview with the same headers and rewrites |
| `apps/committee/` | The member step and the member daemon |
| `proxy/` | Read-only, allowlisted GET proxy for the PQC REST routes (the public REST endpoint sends no CORS headers) |
| `scripts/testnet/` | Accounts, setup, deploy, demo, windows |
| `scripts/local/`, `scripts/e2e-local.ts`, `scripts/local-stack.ts`, `scripts/web-smoke.ts` | Local chain, end-to-end run, browser run (landing page, guest account, whole auction) |
| `test/`, `test-ts/` | Foundry tests (on the kit's precompile mocks) and client tests |
| `deployments/` | Testnet addresses and every transaction hash |
| `docs/spikes.md` | Testnet facts settled by experiment |
| `docs/kits.md` | The QoreChain kits and network features used, why, and the evidence |
| `scripts/evidence.ts`, `deployments/evidence.json` | Every recorded transaction and account re-checked through the `qore` CLI |
| `docs/qorescan/` | The crypto inventory (CycloneDX CBOM) and a draft agility statement, from QoreScan |
| `.mcp.json` | The QoreChain MCP server (read-only) for coding agents working in this repository |
| `client/linked-key.ts` | MetaMask as a linked key on a post-quantum account: the spending rule, the link, MetaMask-signed calls |
| `client/amm.ts` | Buying the quote token on the native AMM: pool quote, swap with a floor, convert to the ERC-20, one transaction |
| `client/audit.ts` | The independent check: release signatures verified with `@qorechain/pqc`, bids reopened from stored shares |
| `docs/DEMO.md` | The 3-minute demo, shot by shot |
| `docs/video/` | The submission video's source (HyperFrames), its script and how to render it |
| `THREAT_MODEL.md`, `AI_USAGE.md` | Trust model; how AI agents built this and what the human decided |

Built with `create-qorechain-dapp` (scaffold), [`qore-pq-kit`](https://github.com/Adityaakr/qore-pq-kit) `v0.1.0`, `@qorechain/sdk` and `@qorechain/evm` 0.14.0, `@qorechain/qoreseal` 0.1.0, `@qorechain/qoresign` 0.2.0, `@qorechain/pqc` 0.2.3, `@qorechain/qorex-types` and `@qorechain/qorex-wallet-mock` 0.1.0, `@qorechain/qore-cli` and `@qorechain/mcp` 0.1.1, `@qorechain/qorescan` 0.1.0, `@qorechain/wallet-adapter` 0.6.0, QoreChain Asset Kit `v0.1.0` (the hybrid holder guard), OpenZeppelin Contracts 5.4.0. Which QoreChain kits and network features this project uses, why, and the evidence for each: [`docs/kits.md`](docs/kits.md).

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

**The look.** The three Peal entries share a family layer, written down in Peal Tender's [`docs/design.md`](https://github.com/Adityaakr/peal-tender/blob/main/docs/design.md): the wordmark and marks, the family line in the footer, voice, evidence and accessibility rules. The design language started from Peal; Peal's interface code was not read or copied. Each product has its own identity on top of that layer: this one is the sealed envelope ([`apps/web/DESIGN.md`](apps/web/DESIGN.md)), written fresh here. The app pages' tokens and components (`styles.css`), the UI helpers and the wallet modules are copied from Peal Tender's `apps/dashboard`, with a note at the top of each file.

**New here:** the whole sealing layer:
- ML-KEM-1024 share envelopes to registered recipient keys;
- ML-DSA-bound committee joins;
- ML-DSA-signed releases;
- on-chain key reconstruction and decryption.

**Dropped from Peal:**
- Peal sealed bids with pairing-based threshold encryption on BLS12-381, which is not post-quantum. None of it is used here.
- Peal's committee reveal root, void and dispute paths are dropped by design.

**One rule changed deliberately.** Peal's settlement credits the issuer with the cost of the whole sold supply at the clearing price. Winners pay their own rounded-down allocations, which can add up to a few base units less. Here proceeds are the exact sum of what winners pay, and a fuzz test checks that every auction ends with both token balances at exactly zero.

## Licence

Apache-2.0, see [`LICENSE`](LICENSE).
