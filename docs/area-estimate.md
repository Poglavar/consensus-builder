# Area estimate

What a rule set would add across an area if every building it allows were built: the command-line
`backend/scripts/area-estimate.mjs`, with its pure parts in `backend/area-estimate/estimate.js`.
It is not part of the app.

## Method

Every building in the area is judged; nothing is sampled.

- **Area:** a WGS84 box, or the statistical small areas whose names start with a given name
  (England's MSOAs, so "Havering" is the borough), read from the shared API.
- **Buildings and streets:** OpenStreetMap through the app's Overpass chain (Tracestrack first),
  in 0.01° cells. A building belongs to the cell its footprint's centre lies in, and to the named
  street nearest that centre within 40 m.
- **Facts:** the shared API's building facts for every building (OSM tags, the heritage register,
  building registers for build dates). These are the facts the building card and the agreement
  editor read.
- **Living Tradition (mansards):** each building against the building eligibility set. Eligible or
  possibly eligible buildings get the mansard storey Plan stats measures on their footprint, with
  party walls from the buildings around.
- **Strong Suburbs:** each street's buildings redrawn on their footprints at the street's storey cap
  (from the density near it) with one setback storey (a mansard). Each street is then checked with
  `StreetCode.check`, the same check the agreement editor and `ugt_draft_agreement` run. The added
  floor area is the redrawn floor area less what the building has. A building whose height the
  facts do not give is counted as unmeasured. `--assume-storeys N` also reports them at N storeys,
  as a stated assumption beside the measured figures.
  - The two ceiling tests (2.5 m minimum, 3 m in the setback storey) are about what the designer
    chooses, not about the site, so the estimate takes them as met and says so.
- **Money:** `moneyOf`, the rule of Plan stats and `ugt_compare`: value, all-in cost and profit of
  the added floor area at the city's prices where each building stands. Nothing is acquired,
  because the buildings are extended.
- **Homes:** the added floor area at Plan stats' efficiency and average flat.

## Output

`summary.json` gives each rule set's counts by verdict and its tests that fail or are unknown,
building by building. It gives two tiers:

- **eligible:** every test met;
- **possible:** no test fails, some fact unknown.

Each tier has its added floor area, homes, value, cost, profit and the viable part (profit above
zero). The per-cell and per-street files keep each building's verdict and figures. A rerun resumes
from them.

## Cost

Each cell is one Overpass call (6 Tracestrack credits). The building facts are read 200 buildings
at a time, each read also asking Overpass. The run is serial and paced. Its time is mostly those
reads, and it is logged per cell and per street with an ETA.
