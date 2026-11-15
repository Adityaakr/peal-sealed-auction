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
