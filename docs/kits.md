# QoreChain kits and network features

What this project uses from QoreChain's kits and network features, why each one serves the product, and the evidence. Researched on 17 November 2026 against the published packages (npm), their READMEs and typings, the QoreChain docs (`qorechain/qorechain-docs`) and the fest site (build.qorechain.io). A kit that does not fit is listed with the reason, rather than added for a checkbox.

## How the fest site checks them

Read from the fest site's own text on 17 November 2026 (project form hints, FAQ):

- **Kits and SDKs:** "We check your repo's dependency files and mark what we find as verified." The FAQ adds "and code". So a kit is verified when its package is a dependency here (`package.json`; for Solidity, the submodule and remappings).
- **Network features:** "We check your testnet addresses on chain and mark what we find as verified." The project lists up to five `qor1` addresses, and a feature is verified when the chain shows it for one of them. So every feature needs on-chain activity from a listed address, not only from some account of the project.
- **Declared** means ticked by the team but not found. On 17 November the project page showed `qorechain-pqc`, QoreX integrations and Wallet adapter as declared (none was a direct dependency), and the EVM window, the QoreSeal key registry and both Solidity PQC features as declared. The listed address had not done those things. The committee and bidder accounts had.

## Kits

| Kit | Used | What it does here | Evidence |
|---|---|---|---|
| QoreChain SDK (`@qorechain/sdk`, `@qorechain/evm`) | yes | Accounts, hybrid signing, PQC key and KEM key registration, EVM windows, window cost | `scripts/testnet/`, `apps/web/src/wallet/guest.ts`; already verified |
| create-qorechain-dapp | yes (scaffold) | The repository was scaffolded from `create-qorechain-dapp@0.14.0 --template foundry` (PR 1). A scaffolder is not a dependency, so the site cannot find it in `package.json`. It stays declared, honestly | `docs/spikes.md`, first row |
| qorechain-pqc (`@qorechain/pqc`) | yes | **Anyone can check an auction in their browser.** The results page verifies every member's ML-DSA-87 release signature with `mldsa87.verify`. It verifies against the key the chain registered (`pqcKeyStatus`), over a message it rebuilds itself. It then reopens every bid from the stored shares. The committee's own release is checked with it before sending | `client/audit.ts`, `test-ts/audit.test.ts`; `npm run testnet -- audit 0x9CbA…c124` verified both real testnet releases |
| QoreSign (`@qorechain/qoresign`) | yes | Recipient cards (classical key from the account key) and key derivation in tests | already verified |
| QoreSeal (`@qorechain/qoreseal`) | yes | Every key share is a hybrid ML-KEM-1024 + X25519 envelope to one member's registered key | already verified |
| QoreX integrations (`@qorechain/qorex-types`, `@qorechain/qorex-wallet-mock`) | yes | The wallet drawer's QoreX path uses the official detection helpers, typings and `qorexSignAndBroadcast`. It reports QoreX's own `shield` check of the funding transaction and refuses a `downgraded` one. The official mock tests it, and drove it on the testnet | `apps/web/src/wallet/qorex.ts`, `test-ts/qorex.test.ts`, `deployments/qorex-proof.json` |
| Wallet adapter (`@qorechain/wallet-adapter`) | follow-up PR | The chain's route for MetaMask on QoreChain: link a MetaMask key to the bidder's post-quantum account as an authenticator, bounded by spending rules, and relay `MsgExecuteEVM`. Today the drawer can only show a MetaMask account. Note: its peers pin cosmjs 0.32 while the SDK uses 0.39; an `overrides` entry resolves it (tried) | planned |
| MCP + qore CLI (`@qorechain/qore-cli`, `@qorechain/mcp`) | yes | **Evidence anyone can re-run.** `npm run evidence` asks the chain, through `qore tx get` and `qore pq status`, about every transaction recorded in `deployments/` and every project account. It writes `deployments/evidence.json`. `.mcp.json` gives the coding agents that build this repository (`AI_USAGE.md`) the same read-only view of the chain; a test starts it and checks that no tool signs | `scripts/evidence.ts`, `test-ts/mcp.test.ts`; on 17 November: 12 of 12 native transactions verified, 7 key registrations, 28 of 28 EVM transactions succeeded |
| QoreScan (`@qorechain/qorescan`) | yes | **The crypto inventory behind the threat model.** `npm run cbom` scans the contracts (with the kit's `PqAuth.sol`, where it finds ML-DSA-87 through the precompiles), three project accounts and the two endpoints the pages use. It writes a CycloneDX CBOM and a draft agility statement | `docs/qorescan/`, `THREAT_MODEL.md` |
| Asset Kit | evaluating | A sealed uniform-price auction is how bond issues are sold. The kit's ERC-3643/CMTAT token with the post-quantum holder check would make the sale token one only accounts with a registered ML-DSA-87 key may hold | under evaluation |
| RDK | no | Rollups are not part of an auction venue | none |
| Custody kit | no | Reference code for custodians and exchanges, not a dependency (published only on GitHub) | none |
| Chain bridge (`@qorechain/chain-bridge`) | no | A server-side hot-wallet library for Web2 backends; this project has no backend and its signing is already done by the SDK. It also needs cosmjs 0.32 | none |
| Handles (`@qorechain/handles`) | no, for now | Resolving committee members' `@handles` would be a good fit, but the registry's base URL and its ed25519 key are not published (the docs list them as prerequisites without values) | none |
| PQ light client (`@qorechain/pq-light-client`) | no | Its own docs: "QoreChain does not produce these checkpoints today, so it cannot verify the live network yet." The browser audit above is what this project can verify honestly today | none |

## Network features

Addresses below are `qor1` forms of this project's throwaway testnet accounts (secrets outside the repository).

| Feature | Used | Where on chain | Account |
|---|---|---|---|
| Hybrid ML-DSA-87 transactions | yes | every native transaction of every account | all |
| PQC key registration with proof of possession | yes | `MsgRegisterPQCKeyV2` by every account; the QoreX-mock account's own registration through the mock | all |
| EVM window (incl. scoped) | yes | scoped windows for every commit, release and claim; unscoped for deploys | deployer, committee1, bidder1 |
| Solidity PQC signature check | yes | `CommitteeRegistry.registerSet` (3 joins) and `SealedAuction.submitRelease` call `pqcVerify` | deployer (registerSet), committee1 and 2 (releases) |
| Solidity PQC key status | yes | the registry reads every member's key with `pqcKeyStatus`; releases read it too | same |
| QoreSeal and the encryption key registry | yes | `MsgRegisterKEMKey` by each committee member | committee1, 2, 3 |
| Test tokens fUSD, fETH, fBTC | yes | fUSD from the faucet, converted with `MsgConvertCoin`, used as the quote token | deployer, bidder1 |
| AMM pools | yes | **A guest can raise the escrow for a fUSD sale.** A browser guest holds QOR, and the fest's fUSD faucet pays only dashboard-registered accounts. So the bid page offers "Buy fUSD on the AMM": a quote from pool 2's reserves, then one hybrid transaction that swaps (`MsgSwapExactIn`, floor = the amount) and converts that amount to the ERC-20 the auction pulls (`MsgConvertCoin`). Also `npm run testnet -- fusd buy` | bidder1 (`3E4AEEBD…6AED`); the browser guest from the bid page (`6EBF2D96…3E72`); `deployments/amm-buy.json` |
| Smart accounts and spending rules | follow-up PR | with the wallet adapter (above): a MetaMask key linked to the bidder's account under a spending rule that allows only this auction and its token | bidder1 |
| Asset Kit | evaluating | see the kit | |
| MCP server or qore CLI | yes | read-only by design, so nothing new lands on chain; it checks every recorded transaction and account (`npm run evidence`) | all listed |
| QoreScan | yes | read-only; its CBOM lists the listed accounts' ML-DSA-87 and ML-KEM keys | deployer, committee1, bidder1 |
| Staking tiers, IBC via QORel, Cross-VM, RDK rollup, sidechain, light node, approved Native contracts | no | none of these is part of a sealed-bid auction; adding one would be a checkbox, not a feature | |
| Sign In With QoreChain | no | the pages have no server to sign in to: members open their shares in their own browser, and the contract checks their signatures | |

## Which addresses to list (draft; final list in the last PR)

The site reads at most five addresses, so they must cover every feature between them:

| Account | `qor1` | Covers |
|---|---|---|
| deployer | `qor1e8kr7whjwt2trzghlwswt337gptdn0jqz33zrh` | hybrid, PQC key, windows (unscoped and scoped), fUSD, registry with `pqcVerify` and `pqcKeyStatus` |
| committee1 | `qor1vnhz8997jwcwss9sdl2f0husu5540phwjx0pdx` | KEM key registry, scoped window, release checked by `pqcVerify` |
| bidder1 | `qor1ppnar99nxc8wq4pyjwt029v0ktcel55952jaj3` | scoped windows, fUSD convert, sealed commits; AMM and spending rules after the follow-ups |
