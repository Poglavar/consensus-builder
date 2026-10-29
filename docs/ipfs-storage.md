# IPFS storage

The application pins IPFS content through `backend/storage/pinning.js`. This boundary owns
byte limits, the fixed UnixFS CID profile, provider selection and confirmation that
the provider retained the expected CID. Routes do not call provider APIs directly.

`pinBytes({ bytes, cid, name })` pins an immutable JSON record; `pinFile(...)` also
handles NFT images and metadata. Both return `{ cid, pinnedAt }`. All new objects,
including NFT metadata, use the same CIDv1 scheme. Existing publication CIDs remain
valid and are not rewritten.

## What is pinned

Pinned on IPFS:

- owner-decision bundles anchored on Solana (`POST /agreements/:cid/decisions/bundle`,
  `approval-anchor.js`);
- signed community reports, which the UI links on `ipfs.io`;
- parcel NFT images and metadata (`/ipfs/upload`).

Not pinned: designs, named plans and agreements. Publishing one is server-only. The
client computes the CID from the canonical bytes, and `POST /designs`, `POST /plans`
or `POST /agreements` indexes the object after checking that CID. Readers get these
objects only from the server index, never from IPFS.

`POST /pins` stays available, but no publication path calls it. It is kept for the
objects a chain record will reference, so the blockchain work can pin them again.
Until then, an agreement minted on Solana points at agreement, plan and design CIDs
that only our index holds.

## Configuration

| Setting | Purpose |
| --- | --- |
| `IPFS_PINNING_PROVIDER` | `filebase` (default) or `pinata` |
| `FILEBASE_ACCESS_KEY_ID` | Filebase S3 access key, backend secret only |
| `FILEBASE_SECRET_ACCESS_KEY` | Filebase S3 secret, backend secret only |
| `FILEBASE_BUCKET` | IPFS bucket; currently `consensus-builder-publications` |
| `PINATA_API_KEY`, `PINATA_API_SECRET` | Reserve provider credentials |
| `IPFS_READ_GATEWAY` | Independent HTTP gateway base ending in `/ipfs` |

Credentials live in the ignored backend `.env`. Public deployment settings live
in `backend/ecosystem.config.cjs`; local overrides can also be set in `.env`.
Changing environment configuration requires restarting the corresponding API
process. Restarting a PM2 deployment must load the ecosystem file rather than
reusing a saved environment. This change does not itself deploy or restart a server.

To select Pinata in reserve, set `IPFS_PINNING_PROVIDER=pinata`. Select a gateway
that serves those pins too, for example
`IPFS_READ_GATEWAY=https://gateway.pinata.cloud/ipfs`. The existing included
Filebase gateway serves only content pinned in its account, so retaining that
gateway while uploading solely to Pinata would not serve the new files.

The two adapters are in `backend/storage/providers/`. Another provider implements
the same input and `{ cid, pinnedAt }` result, then joins the small registry in the
publication boundary. Upload failures stay visible; there is no automatic switch
to another account or provider.

## CID preservation

- Pinata receives files with `cidVersion: 1`.
- Filebase uses its IPFS S3 endpoint (`s3.filebase.com`, region `us-east-1`), not
  its ordinary object-storage endpoint. The adapter imports a CAR with metadata
  `import=car`, then confirms the returned CID and `pinning-status=pinned`.
- CAR construction uses fixed 256 KiB chunks, raw leaves, CIDv1 and no wrapping
  directory, matching the application's browser and server CID functions.
- Read gateways are transport. Selecting another gateway does not change content
  addresses or update gateway URLs already embedded in older metadata.

Filebase's included gateway is used for new Filebase asset URLs. Its existing
account-pins-only scope was retained. Automatic approval review rejected a change
to public scope because it could broaden account content access; that change was
unnecessary for serving the migrated and newly uploaded files.

## October 26 cleanup and verification

The account inventory contained 504 Pinata pins, including 34 images. The user
selected the oldest 250 files of every type, with a backup before unpinning.

Backups are outside the checkout at
`~/Backups/consensus-builder/pinata-2026-10-26-oldest-250`:

- `selection.json`: exact dated pin selection and original metadata.
- `files/`: decoded original file contents.
- `car/`: complete IPFS DAG archives, including the original CIDv0 roots.
- `records/`, `manifest.json`: SHA-256 checksums, original metadata and verification.
- `filebase-copy.json`: confirmation of the same 250 original CIDs pinned on Filebase.
- `unpin-journal.jsonl`, `cleanup-result.json`: per-pin removal receipts and final checks.

All 250 archives were hash-verified, checked for complete linked blocks and decoded
back to their file contents. Every saved archive and file was re-read and verified
before cleanup. Intermittent gateway failures were resumed from per-file checkpoints.
The Filebase copy reached confirmed pinned status for all 250 original CIDs before
Pinata unpinning began. Restore a CAR through an IPFS CAR importer, for example
`ipfs dag import car/<CID>.car`, and pin its original root.

Cleanup completed: 250 successful unpins, zero failures, 254 remaining Pinata pins.
The final inventory contained none of the targeted CIDs and retained every
untargeted pin. Filebase retains all 250 archived CIDs.

Targeted headless unit validation:

- Initial six-file run: 47 passed, three failed. One expectation needed to reflect
  raw adapter timestamps, now normalized by the common boundary. Two unrelated
  approval-anchor route fixtures contain the retired inline-design agreement form
  and fail while constructing their fixture, before pinning executes.
- Five publication files rerun: 43 passed.
- Approval-anchor pure subjects/memo/bundle cases: five passed, two route cases
  excluded by the explicit name filter.
- After adding confirmed-pin waiting: all 12 provider tests passed. CAR checks also
  verify every block hash, all referenced blocks, exact reconstructed file bytes
  and root CIDs across chunk boundaries; the final rerun passed all 12 again.

No full headless unit or Playwright suite was run. No run was stopped. Live checks
confirmed preserved CIDs through Filebase CAR import and matching bytes retrieved
through its included gateway.
