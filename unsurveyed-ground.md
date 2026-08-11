# Ground that is not a parcel

Some land is in no cadastral parcel at all. In Croatia this is normal and specific: public roads and
watercourses (`javno dobro`) are frequently not surveyed as parcels. On the map it shows as an area
with no red parcel outline and nothing to click, which looks identical to a loading failure.

It matters because almost everything in this app is keyed to parcels — block enclosure, the 95%
coverage gate before publishing, ownership, voting. Ground with no parcel is invisible to all of it.

## Finding a single one, from the app

`whatIsHere()` (parcel-cut-debug.js) — pan the spot to the centre of the map and call it. It
distinguishes the four cases that look the same on screen:

| what it says | what it means |
|---|---|
| *n parcel(s) cover this point and are on the map* | it should be clickable; something else is wrong |
| *"X" razed the fabric here* | a park/square/lake — its surface is deliberately non-interactive |
| *n parcel(s) are here but HIDDEN* | a real hole: derived ground claims them and its pieces never arrived. It prints the `deriveArrivingParcels([...])` call to fix it |
| *the cadastre itself has NO parcel here* | unsurveyed ground — this document |

The last verdict is not inferred: it asks `POST /parcels/under` with a ~4 m box around the point and
reports what the backend says. A failed request is reported as **unresolved**, never as "nothing
here" — the difference between "no parcel" and "could not ask" is the whole point.

`whatIsHere(lat, lng)` takes an explicit point.

## Counting them all, from the database

A bounded unsurveyed area is an **interior ring** of the union of every current parcel. The unbounded
outside of the survey is the exterior ring and is not interesting; a hole is bounded by construction.

```sql
-- Union per KO first, then across KOs: collecting hundreds of thousands of polygons in one group is
-- needlessly heavy, and unioning the per-KO results afterwards still catches a hole that straddles a
-- KO boundary, which a per-KO answer alone would miss.
WITH ko AS (
    SELECT maticni_broj FROM cadastral_municipality WHERE grad_opcina ILIKE '%ibenik%'
),
per_ko AS (
    SELECT ST_UnaryUnion(ST_Collect(p.geom)) AS g
    FROM ko k JOIN parcel p ON p.maticni_broj_ko = k.maticni_broj AND p.current
    GROUP BY k.maticni_broj
),
whole AS (SELECT ST_UnaryUnion(ST_Collect(g)) AS g FROM per_ko),
polys AS (SELECT (ST_Dump(g)).geom AS poly FROM whole),
rings AS (SELECT (ST_DumpRings(poly)).* FROM polys)
SELECT round(ST_Area(geom)::numeric) AS m2,
       round(ST_Y(ST_Transform(ST_PointOnSurface(geom), 4326))::numeric, 6) AS lat,
       round(ST_X(ST_Transform(ST_PointOnSurface(geom), 4326))::numeric, 6) AS lng
FROM rings
WHERE path[1] > 0          -- path[1] = 0 is the exterior ring
ORDER BY 1 DESC;
```

Run it as a background job — the Šibenik union over 439,616 parcels takes minutes, and a killed psql
leaves the query running on the server.

**Filter by area before believing the count.** Most rings are sub-square-metre slivers: topological
noise in the survey, not ground anyone can stand on.

### Šibenik, measured 2026-08-11

All 46 cadastral municipalities of the city, 439,616 current parcels:

| bounded holes | count |
|---|---|
| all | 115 |
| ≥ 1 m² | **61** |
| ≥ 10 m² | 53 |
| ≥ 100 m² | **34** |
| ≥ 1,000 m² | 18 |

Total 138,552 m² (~13.9 ha), of which 137,813 m² — **99.5%** — is in the 34 holes over 100 m².
Largest single hole 23,661 m².

In the two KOs the current plan is in (330264, 329924) there are three, two of them 0 m². The one
real hole is **2,590 m² at 43.753797, 15.876488**.

## What NOT to do about it

Do not mint parcels client-side to fill a hole. Two reasons, the second decisive:

1. A failed fetch and an empty answer must never collapse into the same thing (see the demolition
   scan, which recorded "nothing to demolish" whenever its request was refused).
2. **A client cannot tell a cadastral hole from the edge of its own loaded area.** The gap it sees
   extends to wherever it stopped fetching, so minting on it invents a parcel the size of the
   shortfall. Only the database knows the survey's true extent.

`loadedCadastreParcels()` deliberately excludes synthetic ids, and `computeCadastreParcelIds`
refuses to publish below 95% footprint coverage. That gate is what stops a proposal standing on
ground nobody has. Minting a parcel to fill the hole is precisely the act of switching it off.

If this ground should become first-class, derive it server-side from the complement of `parcel.geom`
within each KO — an exact, reviewable, one-off answer — rather than as a browser-side reflex.

## Debugging affordances

- **Already exists:** `POST /parcels/under` returns the parcels under any geometry. A ~4 m box around
  a point is the "what parcel is at this lat/lng" query. It is exempt from the write rate limiter
  (it is a read that uses POST only because a polygon does not fit in a query string).
- **Not built:** a cursor readout printing lat/lng under the mouse. That is the missing half — the
  endpoint is there, the coordinates are the awkward part to obtain by hand.
