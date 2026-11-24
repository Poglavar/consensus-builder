# Astana general plan source

Astana's city configuration selects `astana-genplan-cadastre-2026-11-24`, a dated reference from the state urban-planning cadastre. The `astana-genplan` adapter reads 12,914 functional zones from the `kz:gpzone` layer for administrative territory `710000000`. It shares the snapshot reader and builder with [Alatau](alatau-genplan-source.md).

The date identifies the snapshot. The polygons carry no decree field. The same territory's companion red-line records cite [Decree No. 33 of 25 January 2024](https://primeminister.kz/ru/25012024-33). [Decree No. 697 of 4 August 2026](https://primeminister.kz/ru/decisions/04082026-697) revised the plan, with the [adopted drawing on page 40 of the annex](https://primeminister.kz/assets/media/prilozenie-rus-697.pdf#page=40). The public cadastre polygons have no verified link to that revision. The [municipal 2026 layer](https://gis.esaulet.kz/portal/home/item.html?id=f4ef772903b549e0ae2a417fd12021f3) lists functional zones, implementation status and a creation document field. Its geometry still needs verification before it can supply current rules.

The adapter reads the original use label, class code and implementation stage. Astana housing labels include 1–3, 3–4, 5–9, 10–17 and 18 or more storeys. The map colours the published uses and quotes the full source label in the inspector. Those storey classes do not enter a permitted massing or design check. A zone can supply the exact outline for a design site using the existing map action or the MCP `planningArea` input.

Below zoom 15, 2D loads one simplified whole-plan asset. **Fit plan** uses its complete bounds. From zoom 15 the viewport reads detailed zones from the snapshot. Inspection and design-site creation use the exact record, with its stable ID and original attributes. The zoning overlay does not depend on parcel coverage.

The shared builder accepts the complete source GeoJSON with its match count. Reproduce this snapshot from the decompressed bundled GeoJSON. Give any subsequent capture its own source edition.

```sh
node backend/scripts/build-kz-genplan-snapshot.mjs astana-genplan-cadastre-2026-11-24 /path/to/captured-zones.geojson
```
