# Lovinčićeva, k.č. 4090/1

The recovered below-ground model is the shared C1/CG/C2 basement, attached once under C1 rather than duplicated under C2. Its labels identify the shared garage and cores but do not provide a georeferenced registration. Apartment labels are source references only; no stair runs are modeled from them, and elevations remain estimated.

Author with PyMuPDF and Shapely installed, then review the local database import (dry run by default):

```sh
python3 backend/scripts/reconstruct-borongaj-floors.py \
  --sources rekonstrukcije/pionir-paron/lovinciceva-4090-1/floor-plan-sources.json \
  --proposal rekonstrukcije/pionir-paron/lovinciceva-4090-1/proposal.geojson \
  --cache-dir /tmp/lovinciceva-floor-cache --fetch --write
PGHOST=localhost node --env-file=backend/.env backend/scripts/import-building-floor-plans.mjs \
  --archive rekonstrukcije/pionir-paron/lovinciceva-4090-1/proposal.geojson
```


Permit-driven reconstruction of 12 above-ground volumes A–E3. [`proposal.geojson`](proposal.geojson) is the canonical multi-building export, passes a lossless export/import/export round trip, and corresponds to local unapplied proposal `lovinciceva-location-permit-2019` (row 700).

The signed location-permit totals are kept alongside geometry-derived statistics so alternative urban forms can be compared without confusing the two.
