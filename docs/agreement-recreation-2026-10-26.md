# Agreement contract recreation audit — 2026-10-26

Recreated all 60 exported experimental inline-design agreements as new plan-linked agreement records. All 60 were published and their returned CIDs matched the prepared manifest on exact readback. The new rows have `onchain: null`; recreation did not transfer chain state.

The source export SHA-256 is `bd2e8613691bc859b43d58c077d34d1e3adb6fd989e611ca41217d54f27bfe40`. The complete source-to-new-agreement and plan CID mapping is in [agreement-recreation-2026-10-26.json](agreement-recreation-2026-10-26.json).

Four expired deadlines were renewed to `2026-11-01T23:17:08.000Z` during recreation:

- `bafkreigjvfhkiicydu2fylzhjikq6m4vqgfd45bg3ugovpivgment4moji` — from `2026-10-25T20:25:02.000Z`
- `bafkreighrsumjthvrwvp6s3yttg7wubakigiqz3tam7rnohxwb6tsddc2e` — from `2026-10-25T20:25:51.000Z`
- `bafkreib2xbfqbw5qrxzcodzzyqebmidiwfszuihzbn5yij4zx2gpf62oey` — from `2026-10-25T22:30:23.000Z`
- `bafkreihvc2s2gtqkijuda3scyjfdpb2so2eru4gwdcdwomilcvhzanim4q` — from `2026-10-25T23:15:07.000Z`

The mapping records each renewal’s new deadline and the readback verification timestamp. It contains CID references only, without holder data.
