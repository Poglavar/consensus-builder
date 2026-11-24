# Almaty general plan and detailed plans

The 2040 general plan is available in the planning institute's public map and as the adopted drawing attached to Decree No. 961. The institute serves the drawing as georeferenced images. Its vector tiles supply parcels and boundaries. The drawing tile metadata carries no decree number or revision date. The planning viewer takes vector area records, so the citywide drawing is available through the institute's map. [Institute map](https://map.almatygenplan.kz/) · [Tile metadata](https://map.almatygenplan.kz/t/genplan-raster.json) · [Decree No. 961](https://www.gov.kz/org/almaty-uaig/documents/details/1101671?lang=ru) · [Adopted main drawing, page 39](https://www.gov.kz/api/v1/public/assets/2026/11/17/392c19932ddc4d8bc9d5a286bcc0f059755214351c498c3e00426d9882f18529_original.1664161.pdf#page=39)

The city configuration selects **ПДП Алматы**, a snapshot of the state urban-planning cadastre taken on 24 November 2026. It uses the shared Kazakhstan reader and builder with layer `kz:pdpzone` and territory `750000000`. The snapshot has 1,856 records across three named detailed plans in southwest Almaty. **Fit plan** frames their combined extent. The companion detailed-plan red lines leave the approval number and date unrecorded. The national general-plan zone layer has no records for Almaty city. [Public cadastre](https://map.gov4c.kz/egkn/) · [Almaty detailed-plan layer](https://map.gov4c.kz/ggkgs/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=kz%3Apdpzone&CQL_FILTER=admterr_id%3D%27750000000%27&resultType=hits)

The detailed-plan polygons can be inspected by record ID and used as design sites. Permitted massing intersects the source zones with the configured municipal parcel source. The adapter reads the local functional label and uses bounded residential counts of 3, 5, 6, 9 or 12 storeys at an assumed 3 m per storey. For example, a record labelled 6–9 storeys gives 27 m even when its national classification is 6–12. The source supplies 94 polygons with a finite storey cap. Other polygons remain available for zoning inspection. Evidence shows the captured source properties and the basis of the derived height.

The detailed-plan overview and exact backend snapshot share the same source IDs. Rebuild them from the decompressed bundled GeoJSON.

```sh
node backend/scripts/build-kz-genplan-snapshot.mjs almaty-pdp-cadastre-2026-11-24 /path/to/captured-zones.geojson
```
