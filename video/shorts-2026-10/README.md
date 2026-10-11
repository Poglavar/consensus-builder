# Urban Game Theory shorts

Two hypothetical 9:16 narrated shorts: `hero1982-market-scout` explains proposal-market research and risk; `jane-park-support` follows Jane as she places a small NO forecast stake on an apartment-block proposal, then separately imagines donating $50 in devnet USDC to support a nearby two-parcel park proposal and explores a conditional refund path after an on-chain expiry verdict.

Both scripts use the stock male Chris voice already referenced by the existing ElevenLabs pipeline, with `eleven_multilingual_v2`. No custom voice or person imitation is used. Hero is 248 words and about 102.8 seconds; Jane is 244 words and about 105.8 seconds.

Four code-drawn concept clips accompany the narration: Hero's council-delay scenario, Jane's election scenario, Jane's conditional expiry/refund path, and Jane's illustrative park-donation concept. They were authored as typography and generic vector diagrams with Pillow, then encoded with FFmpeg. They contain no source documents, real election results, proposal identifiers, app UI, transaction records, or receipts. Their labels mark them as illustrative; the refund diagram explains a conditional path and does not claim a real proposal has expired or a refund has been claimed. The donation concept depicts no completed transaction, receipt, or success state. They are supplied at:

- `assets/hero1982-market-scout/04-election-signal.mp4`
- `assets/jane-park-support/04-election-signal.mp4`
- `assets/jane-park-support/08-expiry-refund.mp4`
- `assets/shared/donation-concept.mp4` (7 seconds; suitable as the illustrative segment after a real park-map capture)

These concept clips are editorial explanations, not evidence of an actual proposal or outcome. All other scene assets should be captured from real app or attributable public-source material according to `asset-manifest.json`.

The real apartment-block footage concerns proposal `agent-densifier-01-2026-10-11-h09-1`, shown at [the verified public proposal URL](https://urbangametheory.xyz/?focusProposal=agent-densifier-01-2026-10-11-h09-1&lang=en&city=zagreb). Jane's later park-list shot is a separate public proposal, `upu-borovje-z1-3-v3` (“UPU Borovje – javni park Z1-3”), associated with parcels 1967/1 and 4302/4. The park is published and unminted; its detail URL was not independently verified. The following donation animation is a separate hypothetical concept: no donation, wallet action, receipt, or transaction is shown or claimed for that park.

`generate-voice.mjs` follows the existing per-scene generation pattern. It reads `ELEVENLABS_API_KEY` silently from the process environment or the sibling `emergent-rwa-solana-mobile-hackathon/video/.env`, calls ElevenLabs' timestamped speech endpoint, and writes scene audio and alignment, a stitched narration track, a timeline JSON, transcript, and SRT under this directory. Unchanged clips are reused by content hash.

`usage-audit.json` records per-scene cache keys, whether each saved version is current or superseded, submitted-character counts for the current script, alignment-character counts, observed provider response metadata, and reported USD cost (`null` when billing data is unavailable). The existing entries represent 36 saved audio/alignment pairs, but the earlier pipeline did not persist response headers or billing records; they cannot establish retries or billed cost. Current alignment-character totals match the local submitted text lengths; historical superseded entries retain alignment counts only. Future responses save ElevenLabs' documented `character-cost`, `request-id`, and `x-trace-id` headers when present, without treating character cost as USD. The generator prints the per-scene counts and available cost evidence as it processes them. See [ElevenLabs API response metadata](https://elevenlabs.io/docs/api-reference/introduction) and [timestamped speech alignment semantics](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps).

To rebuild both tracks:

```sh
node video/shorts-2026-10/generate-voice.mjs
```

The timestamp endpoint returns audio and character-level alignment for subtitle timing. See [ElevenLabs' Create speech with timing API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps).
