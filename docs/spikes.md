# Spikes and testnet findings

Testnet facts change quickly and the docs disagree in places, so details are settled by experiment and recorded here with the date and the command that showed them.

## 2026-11-16

| Question | Finding | How |
|---|---|---|
| Does the `create-qorechain-dapp` Foundry template build here? | Yes. `create-qorechain-dapp@0.14.0 --template foundry` scaffolds a Foundry project with `solc 0.8.28` and a window helper (`scripts/window.ts`); the template ships no `.gitignore` and writes a placeholder `.env`, which is not committed | `npx -y create-qorechain-dapp@0.14.0 scaf --template foundry --yes --package-manager npm` |
| Is `qore-pq-kit` tagged yet? | Not yet: `main` holds only its initial commit. This repository writes against the interfaces in the design until the first tag | `git ls-remote https://github.com/Adityaakr/qore-pq-kit` |

## Open questions (to settle on testnet)

- Gas of `submitRelease` with one `pqcVerify` and n shares at realistic bid counts.
- Calldata cost of `commitBid` with three 1,752-byte envelopes.
- Whether the public EVM RPC accepts browser calls (CORS) and whether REST needs the proxy for the KEM route.
