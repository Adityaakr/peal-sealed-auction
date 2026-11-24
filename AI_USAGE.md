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
- **Each slice is one reviewable pull request,** checked by CI. CodeRabbit, an automated reviewer, is connected to the repository but did not review every one: of the first 17 it left inline comments on three and found nothing actionable on a fourth; the [table](#pull-requests-who-did-what-and-what-review-caught) says which. The other review was the agents' own checks and the owner's decision to merge.
- **Prior work is read, never copied.** The worker read the author's earlier private project, Peal, read-only, and ported rules rather than files (README "Prior work").
- **Shared code comes from its owner.** The toolkit `qore-pq-kit` was built in parallel by another worker agent. This worker imported it by git tag and did not write a competing version.

## Pull requests: who did what, and what review caught

All 17 pull requests were written by a worker agent and merged by the human. CodeRabbit counts were read from the GitHub API on 24 November 2026 (inline comments by `coderabbitai[bot]`). "Summary only" means it posted a walkthrough and no inline review (its free plan), "limit" that it answered "Review limit reached", "skipped" that the pull request targeted another branch and automatic review was off there.

| PR | The agent's work | The human's part | CodeRabbit | What else checked it |
|---|---|---|---|---|
| [1](https://github.com/Adityaakr/peal-sealed-auction/pull/1) | scaffold, clearing rule | approved the design | summary only | a differential fuzz test against a reference model |
| [2](https://github.com/Adityaakr/peal-sealed-auction/pull/2) | registry, auction, factory | made the toolkit public again | limit | CI (the toolkit could not be fetched); the agent's review of the ported settlement (rounding) |
| [3](https://github.com/Adityaakr/peal-sealed-auction/pull/3) | client, daemon, local run | merged | limit | a local run with real ML-DSA-87: forged release refused |
| [4](https://github.com/Adityaakr/peal-sealed-auction/pull/4) | web pages, proxy, browser run | merged | limit | CI (no headless shell for that Ubuntu) |
| [5](https://github.com/Adityaakr/peal-sealed-auction/pull/5) | testnet deployment and a whole auction | one faucet claim, how to share it | limit | the live RPC's 10,000-block limit on log queries |
| [6](https://github.com/Adityaakr/peal-sealed-auction/pull/6) | documentation and demo polish | merged | limit | a read-only check of every page on the testnet |
| [7](https://github.com/Adityaakr/peal-sealed-auction/pull/7) | smart-account bids, log pruning | merged | summary only | a failed settle run of the joint demo |
| [8](https://github.com/Adityaakr/peal-sealed-auction/pull/8) | landing page, wallets, hosting | asked for wallet connect and Vercel; chose the wallet paths | limit | building under the CSP; the smoke run |
| [9](https://github.com/Adityaakr/peal-sealed-auction/pull/9) | the landing page's own identity | rejected a shared look; asked for diagrams | limit | the agent's own review: a drawing overstated the trust assumption |
| [10](https://github.com/Adityaakr/peal-sealed-auction/pull/10) | new logos | asked for them | reviewed, nothing actionable | checks at four sizes |
| [11](https://github.com/Adityaakr/peal-sealed-auction/pull/11) | kits plan, audit, QoreX | asked to go deep on kits | **21 inline comments** | the local run (junk bid). The pull request has no commit after the review, so it does not answer the 21 comments |
| [12](https://github.com/Adityaakr/peal-sealed-auction/pull/12) | evidence, MCP, QoreScan | merged | skipped | the first evidence run (three hashes misclassified) |
| [13](https://github.com/Adityaakr/peal-sealed-auction/pull/13) | AMM buy for guests | merged | skipped | a testnet proof |
| [14](https://github.com/Adityaakr/peal-sealed-auction/pull/14) | MetaMask under a spending rule | merged | skipped | the chain refused an oversized approve |
| [15](https://github.com/Adityaakr/peal-sealed-auction/pull/15) | PEAL-B, the guarded bond | merged | skipped | a resumed run after a machine restart |
| [16](https://github.com/Adityaakr/peal-sealed-auction/pull/16) | long demo, hosting check, video source | asked for a final check | **11 inline comments** | the review: early-reading overclaims in README and film. 8 of the 11 are marked addressed in commit [`9d8d747`](https://github.com/Adityaakr/peal-sealed-auction/commit/9d8d74793b433a190bd65341df22826562fa6af7) |
| [17](https://github.com/Adityaakr/peal-sealed-auction/pull/17) | stranger test, `docs/PQC.md` | asked for the re-test | **2 inline comments** | a check against the test sources. The two comments (custody assumption, full auction address) are fixed in the pull request after this one |

In total: 34 inline comments on three pull requests. Examples of comments that stood: the MetaMask rule does not restrict the `approve` spender ([11](https://github.com/Adityaakr/peal-sealed-auction/pull/11), now a stated residual in `THREAT_MODEL.md`); "qualify the early-decryption guarantee" ([16](https://github.com/Adityaakr/peal-sealed-auction/pull/16), fixed there, and the same overclaim in the landing page's hero was found by the 24 November test and fixed after it); "verify excluded bids before marking them as agreeing" ([11](https://github.com/Adityaakr/peal-sealed-auction/pull/11), still open: the audit shows an excluded bid's plaintext but does not repeat the contract's exclusion rule).

## A brief, as written

The orchestrator's specification for the 24 November fixes, verbatim, with local file paths replaced by `[path]` and nothing else changed:

> - From that report fix items 5 (committee check and audit slowing daily: use verified bundled cards first, with on-chain hash verification kept, and scan only as fallback; audit from recorded blocks), 6 (escrow rounded up to a bucket by default, explained in UI, README and threat model, remainder refunded; measure and state honestly what still leaks), 7 (hero overclaim), 8 (AI_USAGE.md accuracy with checked numbers and linked evidence), 10 (drawer hides success), 11 (copy full qor1 address button and funding hint), 12 (stale preview race). Include cheap items 13, 14, 15, 16. Correct item 9's sentence in [path].
> - No contract changes or redeploys, no redesign. Never weaken a cryptographic check for speed; add tests that a wrong bundled card is refused.
> - Everything green, then re-run the hosted-equivalent flow on the production build against testnet, with a throwaway guest. Deployer throwaway funds: at most 2 test QOR. Never print or commit keys; never use the drill key.
> - Report before and after timings. Do not claim what was not measured.

"That report" is another agent's test of the hosted site, from the same day.

## What the AI generated

Everything in this repository:
- the Solidity contracts and their 111 Foundry tests (unit, fuzz, and invariants with a random-actor handler; `forge test` on 24 November 2026);
- the TypeScript client and its 51 tests (`npm run test:ts`);
- the committee daemon;
- the six web pages (the landing page, and the auctions, issuer, bidder, committee and results pages);
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
- **Landing page, wallets and hosting.** The owner asked for wallet connect so the public can try all three products, the shared Peal look, a landing page in each, and hosting on Vercel's free tier, with the wallet paths they chose: a guest account made in the browser and funded by the visitor from the faucet, plus QoreX and MetaMask. The orchestrator dispatched a worker with written instructions in an isolated copy, and steered it through its inbox as the shared design language landed in Peal Tender (`docs/design.md`, PR 8).
  - The worker read Peal Tender's reference implementation and copied the minimum (styles, UI helpers, wallet modules), each with a note, rather than moving page code into the toolkit. It wrote the landing page fresh: the mechanism drawn as SVG with its real names, a step rail that drives a four-panel drawing, live figures from the chain, the security evidence on the dark band, and a guided first bid.
  - It added the guest account to the bid and results pages, a local faucet and demo buyback to the local stack, `vercel.json` with allowlisted rewrites and a Content-Security-Policy, a preview server with the same headers, and a landing and guest phase in the browser smoke run. Checking the build under the CSP showed the SDK needs `'wasm-unsafe-eval'`.
  - It opened the visitors' demo auction on the testnet from the deployer. For the live proof, the orchestrator decided to fund one test guest with 2 QOR from the deployer instead of asking the owner for a faucet claim; real visitors still fund themselves. The worker then drove the production build in headless Chromium through a guest's first bid on the testnet (0.51 QOR in total).
  - What went wrong: the orchestrator's browser tool could not launch the installed Chrome; pointed at Playwright's Chromium it worked. The first smoke run showed the bid page picking the config's sale auction instead of the visitors' demo, and the first screenshots showed the phone-only drawings on desktop; both were fixed before the PR.
- **The landing page's own identity.** The owner asked for a premium, professional landing page with no AI-template look. Then, after seeing the first drafts, the owner asked that the three products not share one landing page, that each be designed from its own concept, and that diagrams carry the explanation.
  - The orchestrator relayed each request with a starting direction for this product: the sealed envelope.
  - The worker loaded the design, diagramming and data-visualisation guidance and wrote the concept first (visitor, five-second idea, metaphor; `apps/web/DESIGN.md`). It rebuilt the landing page around it: a vault of the demo auction's real sealed slots, six diagrams that each answer one question, the testnet run's two ciphertexts opening into the clearing price as the climax, and a requirements table with transaction evidence.
  - It reviewed screenshots at 1440, 1280, 768 and 390 pixels and revised several times before the pull request. It fixed colliding labels, a clipped headline, a heavy chart, desktop drawings shrunk on phones, and a backdrop blur that counted as glassmorphism.
  - One correction came from its own review: the first timeline drawing said two members can read a bid only after the close. That holds for releases, which the contract refuses before the close, but two colluding members could combine shares off chain at any time. The drawing now states the trust assumption, as the threat model does.

### 2026-11-17

- **New logos.** The owner asked for professional logos for all three products. They were designed and merged in Peal Tender (`docs/brand/`, PR 12). The orchestrator dispatched a worker to adopt them here.
  - The worker copied the masters unaltered into `apps/web/public/brand/` (from Peal Tender commit `97011c2`). It replaced the drawn ring marks with the files: the light version on the app pages, the dark version on the landing page, the parent Peal mark beside the family label in the footer. It also replaced the favicon set with the auction tile (SVG, 32 px PNG, 180 px touch icon).
  - It checked the header, the family switcher, the footer and the favicons in headless Chrome at 1440 and 390 pixels and at 16 and 32 pixels. The orchestrator's browser tool again could not launch Chrome, so it drove Chrome for Testing through Playwright.
- **More QoreChain kits, each for a product reason.** The owner asked to use more of the fest's kits and network features, as other entries do, and to go deep rather than tick boxes. The orchestrator dispatched a worker with a written spec in an isolated copy: research first, write the plan, then small PRs with tests and testnet proof.
  - The worker read every listed kit's package, README and typings, the QoreChain docs and the fest site's own text on how it verifies kits (dependency files) and features (on-chain activity of the listed addresses). It wrote `docs/kits.md`: each kit and feature, used or not, and why.
  - First slice: an independent audit (`client/audit.ts`). It verifies release signatures with `@qorechain/pqc` and reopens bids from the stored shares, in the results page and as `npm run testnet -- audit`. It passed against the real testnet run. The QoreX path moved onto `@qorechain/qorex-types`, tested with the official `@qorechain/qorex-wallet-mock` and proven on the testnet. The deployer funded the mock's throwaway account with 0.5 QOR; there was no faucet request.
  - What went wrong: the audit first flagged the local run's junk bid, whose shares rebuild a key that matches no commitment, as a disagreement. That is exactly what "unopenable" means, so the rule was corrected and the local run passed. The browser run needed an installed headless Chromium (`PW_CHROMIUM`); Playwright's own build was missing.
  - Kits it declined, with reasons in `docs/kits.md`: RDK, custody kit, chain bridge, handles (registry not published), PQ light client (cannot verify the live network yet).
  - Second slice: `npm run evidence` re-checks every recorded transaction and account through QoreChain's `qore` CLI. `.mcp.json` gives coding agents in this repository QoreChain's read-only MCP server, with a test that it starts and offers no signing tool. `npm run cbom` writes the QoreScan crypto inventory, now summarised in `THREAT_MODEL.md`. The worker's first evidence run flagged three guest-proof transactions as unverified. They were EVM transactions recorded by their native-style hash, so it now classifies by message type.
  - Third slice, the AMM: first the worker looked for a use that would be more than a swap. Seeding a pool at the auction's clearing price was ruled out by the chain (no permissionless ERC-20 registration, 100 QOR per pool). It kept the one real need: a browser guest has QOR but no fUSD for a sale. It wrote `client/amm.ts` (quote, swap with a floor, convert, one transaction) with tests, a CLI command and a bid-page button, and proved both on the testnet with the deployer's QOR.
  - Fourth slice, MetaMask through the wallet adapter. The worker found the authenticator-link route in `@qorechain/wallet-adapter`'s source and checked it against Peal Bidder's testnet findings. It wrote `client/linked-key.ts`: a spending rule for one auction, the link, and MetaMask-signed calls relayed by the owner. It proved the route on the testnet from the CLI (bidder1) and from the bid page (the guest, with an injected MetaMask stand-in). What went wrong: the first CLI run used 18 decimals for a 6-decimal sale token. The chain refused the oversized approve on the rule's per-call limit, which became evidence that the limit works; the quantity was then fixed. The page proof first failed because the injected provider never announced itself. Two causes, both in the test harness: a `localStorage` read, and tsx's `__name` helper.
  - Fifth slice, the Asset Kit. The worker read the kit's Solidity and chose its guard, small, unchanged and failing closed, over the full ERC-3643/CMTAT stack. It wrote PEAL-B and its tests, added the kit as a pinned submodule, and ran a whole sealed issue on the testnet. A machine restart killed the run after the bids were opened. The worker made the script resumable and finished it the next morning with finalize and payouts. It then wrote the final list for the owner in `docs/kits.md`: which boxes to tick and which five addresses to list. The human decides what to submit.

### 2026-11-21

- **Final check before submissions close.** The owner asked for a final pass on all three entries: hosting, a demo that stays open through judging, the README, the video and the project page. The orchestrator dispatched a worker with a written spec in an isolated copy.
  - The worker re-read the fest's rules and start page and this project's public page, and compared them with the repository. It found the project page's Demo and Video links pointing at the repository, the auto-generated cover, and the visitors' demo auction closing on 23 November, before judging.
  - It opened a new demo auction from the deployer that takes bids until 17 December 2026, 00:00 UTC, so it is open through judging and the demo show. It added `--until` to `create` and made `settle` open bids in chunks that fit one window transaction, so the auction can take 32 bids.
  - It checked the hosting the way Vercel will run it: a clean clone, `npm ci` and the production build with `vercel.json`'s own commands, then the built site behind the same headers and rewrites. A first-time visitor's path ran end to end on the testnet, on a desktop and a phone viewport. A guest was created in the page, funded with 1.2 QOR from the deployer in place of the dashboard faucet (which needs a signed-in visitor), and committed a sealed bid. The results page's in-browser audit of the settled run passed.
  - It made the 2:59 video with HyperFrames on the pattern of Peal Tender's: the landing page's diagrams and the real app, including a second fresh guest's real bid on the testnet. It committed the source in `docs/video/`. The owner uploads the file and pastes the link on the project page.
  - The README now leads with the live link, the 5-minute path, the testnet addresses with their `qor1` forms and the honest limits. The live link resolves once the owner imports the repository in Vercel; the worker has no Vercel account and did not create one.
  - What went wrong: the first section screenshots for the film had the landing page's sticky header over them, and the first renders showed content outside the camera's box in the frame's side margins. Both were fixed before the render.

### 2026-11-23

- **A stranger's test, and tightening for the rubric.** The owner asked for one more pass: re-test the entry as a judge would on the live testnet, fix anything broken, and tighten it against the jury's rubric. The orchestrator dispatched a worker with a written spec in an isolated copy.
  - The worker re-read the rules, prizes and FAQ. The FAQ now gives the rubric: works as described 25%, QoreChain tech usage 25%, post-quantum correctness and security 20%, originality 15%, clarity, UX and documentation 15%. It also says the Solidity PQC features are checked by hand. It wrote a scorecard (criterion, evidence, gap) into the PR.
  - It found the live link still answering 404, because the repository has not been imported in Vercel yet. That is the owner's step, and the worker again did not create an account. It ran the README's steps exactly, on the production build behind Vercel's headers and rewrites, in a fresh Chrome profile: landing page, guest account, 1.2 QOR from the deployer in place of the dashboard faucet, the committee check, a sealed bid committed, the results page and the in-browser audit. Every step worked. A clean clone installed, passed every test and built, and `npm ci` also worked with an empty npm cache and SSH disabled, as on a judge's machine.
  - The first open demo had closed with three visitor bids, and its release window was ending. If no one had released by then, the auction would have failed and refunded everyone. The worker settled it with the existing commands: members 1 and 2 released and `openBids` decrypted the bids. Member 3 then released from its own daemon, so a fresh guest could press *Finalize* and *Pay out every bid* on the results page. `npm run testnet -- audit` passed.
  - It wrote `docs/PQC.md` (every `pqcVerify` and `pqcKeyStatus` call site, what it protects, its tests and a testnet transaction), added explorer links, a "why post-quantum matters here" paragraph and a jury table to the README, and gave the bid page's committee check, which can take up to a minute, a visible state.
  - What went wrong: the browser bridge would not attach to the default Chrome, so the worker drove Chrome for Testing. A gitignored local config left over from `npm run e2e:local` made the first preview show a local auction. The worker deleted it and rebuilt, so the preview matched what Vercel serves. The first draft of `docs/PQC.md` named two fail-closed tests in the wrong files; a check against the test sources caught it.

### 2026-11-24

- **The site went live.** The repository was imported in Vercel, which is the owner's step, after the 23 November entry. <https://peal-sealed-auction.vercel.app> was first recorded answering on 24 November at 18:35 UTC, when the hosted test below started.
- **A test of the hosted site, by an agent that changed nothing.** The owner asked for a full test of the hosted entry and a check of the AI-native requirements. Two new guests, desktop and phone, committed real bids (3 and 4 in the open demo) and every transaction succeeded on chain. Its report found what the earlier passes had missed:
  - The committee check and the audit scanned the chain's logs from the tip, so they got slower every day.
  - The escrow was exactly quantity × limit, and public, so it gave away most of a sealed bid. The threat model said escrow bounds the value; the page offered no way to avoid it and the README left it out.
  - The landing page's hero still said nobody can open a bid early.
  - This file said 105 tests, five pages and that CodeRabbit had checked each slice. All three were wrong.
- **The fixes.** A worker took the report's items, with the brief quoted above.
  - Committee cards that ship with the page are used only where their hash is the one the member signed into the registry. Every later check is unchanged. A wrong card is refused and read from the chain. The audit asks for the recorded blocks first and scans only if they do not hold every release. The committee check went from 33 to 63 s on the live site to 1.4 to 2.0 s, and the audit of the 16 November run from 31 to 33 s to 2.9 to 3.4 s (headless Chromium, same machine and connection; four and two runs before, twelve and six after).
  - The escrow is rounded up to a bucket by default, with a wider bucket, the maximum and the exact amount as choices. The worker measured what the escrow leaves an observer (`test-ts/escrow.test.ts`). Its first ladder left only 6 of the 400 whole-fUSD bids in the top bucket. The measurement showed that, and the ladder now ends at the auction's largest possible bid.
  - Explorer links: the first design linked the EVM hash. Opening one showed the explorer answers "Transaction not found" for it, so the page looks up the native hash first.
  - The wallet drawer closes on success and the outcome is brought into view. A button copies the whole `qor1…` address. The escrow preview is computed in the page, so a slow reply cannot overwrite it. The results page uses plain words and token amounts. Shared links have a card.
  - Tests for wrong bundled cards (tampered, swapped, outsider-signed, malformed, self-consistent but false, broken signature) and for the recorded blocks. `e2e:local` also checks that the remainder of a bucketed escrow comes back.
  - Re-run on the production build against the testnet with two new guests; every hash is under `fixesTest` in `deployments/open-demo-0x53537D…5646.json`. The deployer spent 1.75 test QOR. CodeRabbit then left four inline comments on [the pull request](https://github.com/Adityaakr/peal-sealed-auction/pull/18) (a claim about fractional quantities, an audit report lost if a token name cannot be read, a copy button that redrew the drawer, a malformed bundle that stopped the check); all four were right and are fixed in it. Not tested: the dashboard faucet itself (it needs a sign-in), and the QoreX and MetaMask routes, which were not changed except that the drawer closes on success and the escrow is bucketed.

### 2026-11-25

- **A judge page with nothing to fund.** The owner approved closing the gaps a comparison with other entries had found ("go all three"); one was that a juror could not try anything without funding an account. A worker built `/judge` from a written spec: live reads, and real calls the deployed contracts refuse by name.
  - The worker first probed what the public RPC answers. `eth_call` at old blocks works and the PQC precompiles answer there, so a genuine release is accepted one block before it landed and a forged one is refused by `ReleaseSignatureInvalid` in the same state. State overrides were the first idea for a fallback; under an override the precompiles answer nothing (`PqPrecompileUnavailable`), so they are not used.
  - The forged signature is an outsider's valid ML-DSA-87 signature over the exact message, made once by `scripts/judge-fixture.ts` with a throwaway key that was not kept. The page holds no key.
  - What a call cannot reach is stated in the page, and one row shows something the contract does accept (envelopes addressed to nobody).
  - `npm run judge:live` (28 answers) and the headless browser run on the production build passed against the testnet. CI runs the browser part on recorded testnet answers.
