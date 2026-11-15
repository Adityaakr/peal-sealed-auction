# AI usage

How this repository was built, kept as a dated log. All dates UTC.

## Workflow

- **Orchestrator.** One supervising agent ("firstmate") dispatches worker agents, one per repository, each with a written brief. Each worker runs in its own isolated git worktree and ships its work as reviewable pull requests on its own branch. Workers never push to `main` and never merge.
- **Worker.** This repository is built by a Claude Code worker agent (Claude Opus 5.5). It writes the code, tests and docs, runs `forge test` locally, and opens the pull requests.
- **Human (the project owner).** Approves the design and every decision that shapes the product, holds all keys and test funds, claims faucet funds, and approves every merge.
- **Sources.** The worker reads the author's earlier private project, Peal, read-only, and ports rules rather than files (see README "Prior work").

## Decisions the human made

Recorded from the approved combined design (2026-11-15/16):

- D1: approve the combined design for the three entries and the shared toolkit.
- D2: a treasury buyback runs as the vault selling fUSD for PEAL-T on this forward sealed auction; no second clearing engine.
- D3: the owner holds the three committee keys as separate demo accounts, disclosed.
- D4: the fest's fUSD as the quote token, plus a PEAL-T demo token with a faucet.
- D6: the shared toolkit is distributed by git tags; nothing on npm.
- D7: Apache-2.0.
- D8: no public "try it" bidding.

## Log

### 2026-11-16

- Worker scaffolded the repository from `create-qorechain-dapp@0.14.0` (`foundry` template), kept its window helper, and pinned dependencies (forge-std v1.11.0, OpenZeppelin Contracts v5.4.0, `@qorechain/*` 0.14.0 exactly).
- Worker ported the uniform clearing rule and the decimal-safe price math from Peal as fresh code (`ClearingPrice.sol`, `AuctionMath.sol`), rewrote Peal's clearing test cases, and added a differential fuzz test against a slow reference model of the rule. 26 tests pass.
- Worker wrote the first README, this file and `THREAT_MODEL.md`.
- Not done by the AI: no key was created, no transaction was sent, nothing was deployed.
- Human: merged the first pull request.
- Worker wrote the committee registry (ML-DSA-87 joins binding ML-KEM key hashes and card hashes), the sealed auction lifecycle (commit, close, signed releases, on-chain key rebuild and decryption, finalize, claims), the factory, and the PEAL-T demo token and faucet. Structure ported from Peal; the sealing layer is new.
- Worker built against interfaces before the toolkit was tagged, using a read-only local copy that was never committed. It switched to `qore-pq-kit` `v0.1.0` (`PqAuth`, `Shamir`, `SealedSlot`, test mocks) as soon as that tag existed.
- What the worker found and changed:
  - The toolkit defines a card hash as keccak256 of the card's signed text, so the registry now takes the member-signed hash instead of hashing raw card bytes.
  - Peal's settlement could credit the issuer a few base units more than winners paid. Proceeds here are the exact sum of payments.
  - A bidder could commit a share hash of a value outside the field. That share would then revert key recombination for every caller. Releases now refuse such shares; a member flags them instead.
- Tests: 105 Foundry tests (unit, fuzz with exact token conservation over whole auctions, and invariants with a random-actor handler). Probe invariants were used once to confirm the handler reaches settled auctions with burned bonds, then removed.
- Human: merged the second pull request.
- Worker wrote the TypeScript client (`client/`): committee discovery and checks through the kit's `verifyMember`, bid sealing through the kit's `sealSlot`, share opening, and release signing with local ML-DSA-87 verification. It also wrote the committee member step and daemon (`apps/committee/`), vitest tests with real QoreSeal and ML-DSA-87, and a local end-to-end run on anvil.
- Design choice by the worker: the local run uses real ML-DSA-87 signatures. The EVM cannot verify them, so a local-only stand-in (`OraclePqcVerify`) returns the verdict the harness got from real ML-DSA-87 verification. This keeps the forged-release refusal real instead of mocking every signature as valid.
- Human: merged the third pull request.
- Worker wrote the web pages (bidder, committee member, results), the read-only REST proxy, and a long-running local stack. It also wrote `web:smoke`, which drives the pages through a whole auction in headless Chromium. The bids are sealed, and the shares opened and releases signed, inside the browser.
- What went wrong: the orchestrator's browser tool (`chrome-devtools-axi`) could not attach to a browser in this session. The worker used Playwright's headless Chromium instead, first from a scratch script, then as `scripts/web-smoke.ts` in CI.

