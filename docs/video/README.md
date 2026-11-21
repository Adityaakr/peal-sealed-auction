# The Peal Sealed Auction video

The submission video for QoreChain "Build Before Q-Day" (Encrypted Apps category): a 2:59
narrated explainer and demo, 1920x1080 at 30 fps. This folder holds its source; the rendered
file, the screenshots, the voice and the music are not committed. The rendered file is linked
on the [project page](https://build.qorechain.io/p/peal-sealed-auction).

| File | What |
| --- | --- |
| [`src/scenes/`](src/scenes) | The nine scenes (HTML + GSAP), timed to the narration |
| [`src/build.mjs`](src/build.mjs) | Writes the HyperFrames project (`index.html`, `compositions/`) from `src/` |
| [`src/common.css`](src/common.css), [`src/helpers.js`](src/helpers.js) | This product's identity ([`apps/web/DESIGN.md`](../../apps/web/DESIGN.md): night, brass, Martian Mono and Geist) and the shared motion helpers (camera framing, focus frames, blur-in) |
| [`src/audio.json`](src/audio.json) | Voice, music bed and five sound effects, with their times and levels |
| [`src/voice/`](src/voice) | The narration, one file per scene, spelled for the voice ("M L K E M ten twenty-four", "Core Chain", "P Q C verify"), and the track assembler |
| [`src/capture.mjs`](src/capture.mjs) | Screenshots of the real landing page and app the film shows, including a fresh guest account's real bid on the testnet |

## What the film shows, in order

1. **The problem** (0:00): one auction key means its holder can read every bid early (the landing page's section 01).
2. **Peal Sealed Auction** (0:15): the lockup, then the landing page's open demo auction and its three committee keys.
3. **How a bid is sealed** (0:31): 32 bytes under a fresh key K, K split 2 of 3, each share sealed with ML-KEM-1024 to a registered key; what `commitBid` stores (section 02).
4. **A visitor's bid, live on the testnet** (0:56): the production build on `qorechain-diana`, 21 November 2026. A guest account made in the page, funded, the committee check (three green checks), *Seal in this browser and commit*, the drawer's log (ML-DSA-87 key registered, one EVM window scoped to three contracts, faucet claim, approve, commit), and the three 1,752-byte envelopes. The bid is real: auction `0x53537D8510AD0567F6E44613257Ae7b513395646`, commit `0xd1829394ede92bf0767438cdc39c24ce279dae3971803d79ff46c49070ed386d`.
5. **After the close** (1:36): releases signed with ML-DSA-87 and checked by `pqcVerify`, the forged release refused, K rebuilt from two shares, `openBids` (section 04).
6. **Live proof** (2:00): the 16 November testnet run (section 05): two ciphertexts opened, cleared at 1.50 fUSD, every transaction; then the results page's *Check it in this browser*, audit passed.
7. **The category's requirements** (2:23): the four rows with their evidence, and 111 Solidity tests.
8. **Try it** (2:43): the demo auction is open until 17 December 2026, 00:00 UTC, at <https://peal-sealed-auction.vercel.app>, with the demo's trust disclosure on screen: one owner holds all three member keys, and confidentiality assumes fewer than two members collude.
9. **Outro** (2:53): the lockup, "Sealed until two of three keys meet", the repository and the Peal family.

Every figure on screen comes from this repository (`README.md`, `deployments/`) or from the screens themselves. Only public addresses and transaction hashes appear; no key or recovery phrase is shown or spoken.

## Rebuild it

Needs Node.js 22, ffmpeg, Python 3 and the HyperFrames CLI (0.9.58), plus a Chromium for the screenshots. Work in a scratch folder outside the repository, since the media is large.

```sh
export REPO=/absolute/path/to/peal-sealed-auction   # this repository's checkout
npx hyperframes init film --skip-skills             # a HyperFrames project, in a scratch folder
cp -R "$REPO/docs/video/src" film/src
# Assets the source expects, under film/assets/:
#   brand/   lockup-dark.svg, mark-dark.svg from apps/web/public/brand/auction/;
#            tender-mark-dark.svg and bidder-mark-dark.svg from apps/web/public/brand/{tender,bidder}/mark-dark.svg
#   fonts/   Geist.woff2, GeistMono.woff2, MartianMono.woff2 (Google Fonts, OFL; latin subset), as in src/fonts.css
#   music/bed.mp3   "Happy Beats / Business Moves vol. 12" by ende.app (CC BY 4.0)
#   sfx/     drop_001, drop_002, impactSoft_medium_001, bong_001 (.ogg, Kenney, CC0)
#   shots/   npm run web:build && npm run web:preview in the repository, then src/capture.mjs (see its header)
#   vo/ and voiceover.wav   see src/voice/assemble.py
cd film && node src/build.mjs && npx hyperframes check && npx hyperframes render --quality delivery -o ../peal-sealed-auction.mp4
```

The voice is Kokoro-82M (`af_heart`) on the local machine through `npx hyperframes tts`; it needs the `kokoro-onnx` Python package (`HYPERFRAMES_PYTHON` can point at a venv that has it).

Made with HyperFrames by a worker agent, on the pattern of Peal Tender's film; see [AI_USAGE.md](../../AI_USAGE.md).
