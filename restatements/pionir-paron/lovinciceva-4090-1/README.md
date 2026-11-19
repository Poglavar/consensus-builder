# Lovinčićeva, k.č. 4090/1

The recovered below-ground model is the shared C1/CG/C2 basement, attached once under C1 rather than duplicated under C2. Its labels identify the shared garage and cores but do not provide a georeferenced registration. Apartment labels are source references only; no stair runs are modeled from them, and elevations remain estimated.

Author with PyMuPDF and Shapely installed:

```sh
python3 backend/scripts/reconstruct-borongaj-floors.py \
  --sources restatements/pionir-paron/lovinciceva-4090-1/floor-plan-sources.json \
  --proposal restatements/pionir-paron/lovinciceva-4090-1/proposal.geojson \
  --cache-dir /tmp/lovinciceva-floor-cache --fetch --write
```

Floor plans reach the app only as shared published documents (cadastre-data `buildings.floor_plan`, written by zagreb-novogradnje's publication import); the archive's `floorPlans` are authoring output and evidence. See [building floor models](../../../docs/building-floor-models.md#where-floor-plans-are-stored).


Permit-driven reconstruction of 12 above-ground volumes A–E3. [`proposal.geojson`](proposal.geojson) is the canonical multi-building export, passes a lossless export/import/export round trip, and corresponds to local unapplied proposal `lovinciceva-location-permit-2019` (row 700).

The signed location-permit totals are kept alongside geometry-derived statistics so alternative urban forms can be compared without confusing the two.
