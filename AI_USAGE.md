# AI usage

How this repository was built: the workflow, what the AI generated, what went wrong, and what the human decided. The log at the end is dated (UTC).

## Workflow

```
 Human (project owner)
   │  approves the design and every product decision; holds keys and test funds;
   │  claims the faucet; reviews and merges every pull request
   ▼
 Orchestrator agent ("firstmate")
   │  writes a brief per repository; relays decisions, merges and funding;
   │  never writes this repository's code
   ▼
 Worker agent (Claude Code, Claude Opus 5.5), one per repository
      works in an isolated git worktree on one branch; ships small pull requests;
      never pushes to main, never merges; reports each PR and every blocker
```

- **Briefs and steering are written down.** The worker starts from a written brief and the approved design report. The orchestrator steers it through durable inbox messages ("PR merged, continue", "the owner funded the deployer; transfer X to Y first"). The worker acknowledges each one and reports progress in a status file.
- **Each slice is one reviewable pull request,** checked by CI and an automated reviewer (CodeRabbit). The PRs, in order:
  1. clearing rule;
  2. contracts;
  3. client and daemon;
  4. web pages;
  5. testnet deployment;
  6. this documentation and demo polish.
- **Prior work is read, never copied.** The worker read the author's earlier private project, Peal, read-only, and ported rules rather than files (README "Prior work").
- **Shared code comes from its owner.** The toolkit `qore-pq-kit` was built in parallel by another worker agent. This worker imported it by git tag and did not write a competing version.

## What the AI generated

Everything in this repository:
- the Solidity contracts and their 105 Foundry tests (unit, fuzz, and invariants with a random-actor handler);
- the TypeScript client and its tests;
- the committee daemon;
- the five web pages;
- the REST proxy;
- the local stack, the end-to-end and browser runs;
- the testnet scripts;
- all documentation.

The worker also ran the testnet deployment and the demo auction.

## What the human contributed and decided

- **The product and its design**: the approved combined design, including:
  - **D1**, approve the design;
  - **D2**, buybacks run as the treasury selling fUSD on this forward auction;
  - **D3**, the owner holds the three committee keys, disclosed;
  - **D4**, fUSD plus a PEAL-T demo token;
  - **D6**, the toolkit is distributed by git tags;
  - **D7**, Apache-2.0;
  - **D8**, no public bidding.
- **Every merge.** No pull request merged without the human.
- **Funds**: the faucet claims, and how one claim is shared across all the fest entries.
- **Repository visibility**: when the toolkit repository went private and broke CI here, the owner chose to make it public again.

## What went wrong, and what the agents caught

| What | How it surfaced | Outcome |
|---|---|---|
| Stack too deep in `commitBid` and `registerSet` | compile error | inputs restructured, then `via_ir` |
| The registry hashed raw card bytes; the toolkit defines the card hash over the signed text | reading the toolkit's tagged code before integrating | the registry takes the member-signed hash |
| Peal's settlement could credit the issuer a few base units more than winners paid | reviewing the port | proceeds are the exact sum; a fuzz test ends every auction at zero balances |
| A share hash committed for a value outside the field would make recombination revert for every caller | reviewing the release path | releases refuse such shares; tested |
| The toolkit repository turned private and CI could not fetch it | CI failure | reported as a decision; the owner made it public |
| The orchestrator's browser tool could not attach to a browser | tool errors | Playwright's headless Chromium, now `npm run web:smoke` in CI |
| Playwright has no headless shell for Ubuntu 26.04 | CI failure | that job pinned to Ubuntu 24.04 |
| A bank send with unsorted coins was refused and still charged 0.3 QOR | testnet | coins are sorted; recorded in `docs/spikes.md` |
| The public RPC refuses `eth_getLogs` over 10,000 blocks | the first testnet demo attempt | logs are read in chunks; the auction it had created was closed and its supply returned |
| A guessed gas figure (313k per `pqcVerify`) | measured on the testnet | the real `submitRelease` is 285k in total; docs corrected |
| Smart-account bids (`MsgExecuteEVM`) emit no EVM logs, so committee members could not find their envelopes | the first settle run of the joint demo auction failed | bids are read from contract storage, and envelopes from the `MsgExecuteEVM` calldata via REST; members released in time |
| The worker first misread the node's pruning as two hours of history | rechecking block numbers | corrected in the status report within minutes: about 1.4M blocks; cards saved anyway as a fallback |

## Log

### 2026-11-16

- **Scaffold and clearing rule.** Worker scaffolded the repository from `create-qorechain-dapp@0.14.0` (`foundry` template) and pinned dependencies. It ported the uniform clearing rule and the price math from Peal as fresh code. It rewrote Peal's clearing tests and added a differential fuzz test against a reference model. It wrote the first README, this file and `THREAT_MODEL.md`. Human merged PR 1.
- **Contracts.** Worker wrote the committee registry (ML-DSA-87 joins), the sealed auction lifecycle (commit, close, signed releases, on-chain key rebuild and decryption, finalize, claims), the factory, and the demo token and faucet.
  - Before the toolkit was tagged, the worker built against a read-only local copy that was never committed. It switched to `qore-pq-kit` `v0.1.0` as soon as that tag existed.
  - When the toolkit repository briefly went private and CI failed, the worker raised it as a decision; the owner made it public again.
  - Human merged PR 2.
- **Client, daemon, local run.** Worker wrote the TypeScript client, the committee daemon, vitest tests with real QoreSeal and ML-DSA-87, and the local end-to-end run. In that run, a local-only stand-in gives `pqcVerify` the verdict of real ML-DSA-87 verification, so the forged-release refusal is real. Human merged PR 3.
- **Web pages.** Worker wrote the bidder, committee and results pages, the REST proxy, the local stack and the headless-browser run. Human merged PR 4.
- **Testnet.** The owner made one faucet claim to the deployer. The worker first sent the transfers the owner allocated to the other entries (one transaction, hash recorded), then:
  - set up its six accounts;
  - deployed the contracts;
  - registered the committee;
  - ran a whole sealed auction on the testnet in scoped windows, with a forged release refused by the live `pqcVerify` and member 3 offline.

  Human merged PR 5.
- **Polish.** Worker restructured the README around the category's requirements, with evidence. It turned the threat model into an attack-by-attack table that names the test or testnet evidence for each defence. It added a shot list for the video (`docs/DEMO.md`) and a `create` command. It made the results and home pages read in parallel. Then it checked every page against the live testnet at zero cost (reads only): the bidder's committee check, member 1 opening its real shares in the browser, and the settled results.
- **Joint demo.** On the orchestrator's request, the worker opened an auction for the Peal Bidder agent's demo (`0x481FBb2C84582BF7c258c46BF523DEEbDe51E990`, 48 ticks so the agent's mandate limit of tick 40 binds) and started `settle`. That command waits for the close, has two members release, opens and finalizes. The worker does not coordinate with the Bidder's worker directly; the orchestrator relays.
