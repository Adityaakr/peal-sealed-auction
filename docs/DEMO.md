# The 3-minute demo

A shot list for the Encrypted Apps video, following the design's demo script. Every shot is something that runs today. The testnet shots cost very little: about 0.35 QOR per bidder and 0.33 QOR per committee member per run. Shots marked *local* use the local stack, which costs nothing.

## Before recording

```sh
npm run testnet -- setup                       # tops every account up from the deployer
npm run testnet -- accounts status             # all keys registered, enough QOR and fUSD
```

Open a new testnet auction for the video with `npm run testnet -- create` (15 minutes of bidding, then 15 for releases; `--commit-seconds` and `--release-seconds` change that). Then give each account the scoped window it needs:

```sh
npm run testnet -- window bidder1 0x<auction>
npm run testnet -- window bidder2 0x<auction>
npm run testnet -- window committee1 0x<auction>
npm run testnet -- window committee2 0x<auction>
npm run testnet -- window deployer 0x<auction>
npm run web                                    # http://localhost:5173/?net=testnet&auction=0x<auction>
```

## Shots

| Time | Shot | Where |
|---|---|---|
| 0:00 | **The problem.** QoreChain's recipe encrypts every bid to one auction key, so its holder can read everything early. One slide: "one key holder" vs "2 of 3, nobody alone". | slide |
| 0:20 | **The committee is real.** Three members' ML-DSA-87 keys (`pqcKeyStatus`) and ML-KEM-1024 keys (`/qorechain/pqc/v1/kem/…`) on chain. The registry's `registerSet` transaction, where three ML-DSA joins were verified by `pqcVerify`. | README "Live on the testnet"; `deployments/qorechain-diana.json` |
| 0:40 | **Bidding.** On the bid page, "Check every member's keys": three green checks (the key from the chain, the key from REST against the signed hash, the card). Enter a quantity and price, then "Seal in this browser and commit". The page shows the ciphertext, three 1,752-byte envelopes and "sealed in N ms, in this browser". Do it for two bidders. | `/bidder.html?net=testnet` |
| 1:10 | **One member alone learns nothing.** On the committee page as member 1, "Open my shares in this browser": one random number per bid, no bid. | `/committee.html?net=testnet` |
| 1:30 | **Close and release.** Close bidding on the results page. Member 1 and member 2 each sign and submit their release with ML-DSA-87 from their own page. Member 3 stays offline, and the results page shows `1:✓ 2:✓ 3:–`. | committee and results pages |
| 2:00 | **Anyone opens and settles.** "Open all bids": the contract rebuilds each key from two shares and decrypts on chain, so every row turns from "sealed" to "60 @ tick 3". Then finalize, at one clearing price, and pay out. | `/results.html?net=testnet` |
| 2:20 | **Refusals.** (a) A forged release (an outsider's ML-DSA-87 key in member 3's slot) is refused by the live `pqcVerify`: the `demo` run's log line. (b) A REST proxy that swaps a member's ML-KEM key is caught, and (c) a junk bid is excluded while the auction still settles: `npm run e2e:local` output. *(b, c local)* | terminal |
| 2:45 | **Trust model card and credits.** t-of-n confidentiality; no single key holder; what is post-quantum; the owner holds all three demo keys (disclosed); built on `qore-pq-kit`, QoreSeal and the QoreChain SDK; prior work: Peal. | `THREAT_MODEL.md` |

## If something goes wrong while recording

- **A page says "transaction reverted" on send:** the account's scoped window is spent or missing. Run `npm run testnet -- window <name> 0x<auction>` again.
- **The bid page cannot read REST:** run the dev server (`npm run web`), which proxies `/rest`, or `npm run proxy`.
- **Out of QOR:** `npm run testnet -- setup` tops the accounts up from the deployer.
