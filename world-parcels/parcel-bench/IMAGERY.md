# Imagery sources for ParcelBench

<!-- Which imagery we may train on, cross-check with, or fall back to, with resolution, access and the licence
clause that decides ML use. Checked 2026-10-13 (provider pages; † = provider page seen only as a search excerpt,
UNVERIFIED = no primary source). Recheck a row before a download that depends on it: terms change. -->

**Our benchmarks are the best case.** Croatian orthophotos are flown by aircraft at low altitude: Zagreb CDOF
0.15 m (model grid 0.3 m), Split DGU DOF 0.5 m. Most of the world has only satellite imagery: 0.3–0.5 m commercial
at best, often 1–10 m free, with haze, off-nadir lean and older capture dates. Known cost so far: the Zagreb
selection split degraded to 0.5 m scores 0.239 against 0.294. Every claim about uncovered cities must be read
against satellite-like input, not against Croatia.

Columns: **ML / derived** = may we train models and keep derived parcel polygons. Y = licence allows
adaptation and reuse with no AI carve-out (a reading, not legal advice); N = barred; ? = unclear.

## Free web basemaps: not usable for training without a written licence

| Service | Deciding terms | URL |
|---|---|---|
| Google Maps Platform / Earth | Terms last modified 2026-08-26, §3.2.3: (a)(ii) no "bulk download Google Maps tiles"; (b) "will not cache"; (c)(i) no tracing; (c)(vii) no use "to improve machine learning and artificial intelligence models, including to train, test, validate or fine-tune the models". Imagery is largely licensed from third parties (Airbus, Maxar and others). Status: the user reports informal approval from Google leadership; usable only once a written permission waiving (a), (b), (c)(i) and (c)(vii) for our scope is on file with the project owner. | https://cloud.google.com/maps-platform/terms |
| Esri World Imagery / Wayback | MA rev. 2025-08-01 §3.2(c) "may not otherwise scrape, download, or store Data"; §3.3(h) may not use Data "to teach or train machine systems, models… neural networks". Tracing for OSM allowed. | https://assets.esri.com/content/dam/esrisites/en-us/media/legal/ma-full/ma-full.pdf |
| Mapbox Satellite | Product terms 2026-07-21 §1.5(ii) no use "to train, operate or improve machine-learning or artificial intelligence"; §1.9 no bulk download or caching. Tracing for OSM or non-commercial allowed. | https://www.mapbox.com/legal/product-terms |
| Bing / Azure Maps | "not… copy, cache, or retain any maps… images". Bing basic keys ended 2025-06-30, enterprise ends 2028-06-30. OSM background use only. | https://microsoft.com/maps/assets/docs/terms.aspx |
| MapTiler Satellite | "may not produce commercial derivative works… includes… the training of machine learning algorithms". | https://www.maptiler.com/terms/ |
| HERE | §6.3(f) no use "in connection with a machine learning or artificial intelligence… system". | https://legal.here.com/en-gb/terms/here-platform-terms |

## Free satellite imagery (cross-check and backup)

| Source | m/px | Coverage | Access | Licence | ML / derived | URL |
|---|---|---|---|---|---|---|
| Satellogic EarthView | 1.0 RGBN | All continents, mostly 2022, single date, patchy | AWS S3 + STAC, no sign-in | CC BY 4.0 | Y / Y | https://registry.opendata.aws/satellogic-earthview/ |
| Sentinel-2 L2A | 10 | Global land, 2015–, ~5 days | CDSE STAC, AWS | Copernicus free, full and open | Y / Y (too coarse for urban parcels; usable for large fields) | https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice |
| Landsat 8/9 | 15 / 30 | Global, 8 days | EarthExplorer, AWS | US public domain | Y / Y (too coarse) | https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits |
| Google Earth Timelapse annual mosaics (opened 2026-10-20) | 30 | Global, one cloud-free RGB mosaic per year 1984–2022, built from Landsat and Sentinel-2 | Earth Engine `projects/ee-earth-timelapse/assets/annual` | CC BY 4.0, cite "Google Earth Timelapse (Google, Landsat, Copernicus)" + Copernicus notice | Y / Y (far too coarse to see parcels; possible use: the year an area was first built up, as a prior) | https://developers.google.com/earth-engine/datasets/catalog/projects_ee-earth-timelapse_assets_annual |
| Vantor (ex-Maxar) Open Data | 0.3–0.5 | Disaster activations only | AWS STAC/COG | CC BY-NC 4.0 | non-commercial only | https://registry.opendata.aws/vantor-open-data/ |
| Planet Education & Research | 3 | Global, 30-day delay, 3,000 km²/month | Explorer/API | personal non-commercial research licence, university email | ? | https://planet.com/markets/education-and-research/ |
| Planet NICFI tropics | ~4.8 | Ended 2025-01-24 (access to 2025-03-31) | n/a | n/a | n/a | https://community.planet.com/tropical-basemaps-85/nicfi-satellite-data-program-prolongs-public-access-to-high-resolution-rainforest-satellite-images-6020 |
| Copernicus VHR mosaics / contributing missions | 2 | EEA-39 | WMS view only, eligibility-gated | "only available as a web map service… not for data download" | N | https://land.copernicus.eu/api/en/products/european-image-mosaic/very-high-resolution-image-mosaic-2021-true-colour-2m |
| Umbra, Capella open SAR | 0.16–1 | Sites and scenes | AWS STAC/COG | CC BY 4.0 | Y / Y (radar, not optical) | https://registry.opendata.aws/umbra-open-data/ |

## Open national aerial programmes (sub-metre)

| Programme | m/px | Access | Licence | ML / derived | URL |
|---|---|---|---|---|---|
| France BD ORTHO | 0.20 | download, WMTS | Licence Ouverte 2.0 | Y / Y | https://www.data.gouv.fr/datasets/bd-ortho-r |
| Netherlands Luchtfoto | 0.08 / 0.25 | PDOK WMTS, download | CC BY 4.0†, open since 2025-06-12 | Y / Y | https://www.beeldmateriaal.nl/dataroom |
| Spain PNOA | 0.25 (some 0.15) | CNIG download, WMTS | CC BY 4.0 | Y / Y | https://www.idee.es/csw-codsi-idee/srv/api/records/spaignwmts_pnoa-ma |
| Switzerland SWISSIMAGE | 0.10 | COG download, WMTS | OGD, commercial use allowed, attribution | Y / Y | https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10 |
| Slovenia GURS DOF025 | 0.25 | download, WMS | CC BY 4.0† | Y / Y | https://podatki.gov.si/dataset/ortofoto |
| Czechia ČÚZK | 0.125 | ATOM | CC BY 4.0 since 2023-07-01† | Y / Y | https://geoportal.cuzk.cz/Default.aspx?mode=TextMeta&text=ortofoto_info&side=ortofoto |
| Poland GUGiK | 0.25 (urban 0.05–0.10) | download, WMS/WMTS | free "for any purpose"†, no named licence | Y? | https://www.geoportal.gov.pl/en/data/orthophotomap-orto/ |
| Austria basemap.at / BEV | 0.29 / 0.20 | WMTS | OGD Austria / CC BY 4.0† | Y / Y | https://basemap.at/en/orthofoto-2/ |
| Germany NRW, Brandenburg, Bayern | 0.10–0.20 | download, WMS | dl-de/zero†, dl-de/by-2.0, CC BY 4.0† | Y / Y | https://www.opengeodata.nrw.de/produkte/geobasis/lusat/akt/dop/dop_jp2_f10/ |
| Finland NLS | 0.5 | MapSite download, WMTS | CC BY 4.0† | Y / Y | https://www.maanmittauslaitos.fi/en/maps-and-spatial-data/datasets-and-interfaces/product-descriptions/orthophotos |
| Sweden Lantmäteriet | 0.16–0.5 | Geotorget | open since 2025-02-03, CC0†, personal-data terms on download | Y? / ? | https://www.lantmateriet.se/en/geodata/our-products/open-data/ |
| Luxembourg ACT | ≤0.10 | data.public.lu | CC0† | Y / Y | https://data.public.lu/en/datasets/orthophoto-officielle-du-grand-duche-de-luxembourg-edition-2023/ |
| USA NAIP | 0.3–1 | AWS COG | public domain with attribution | Y / Y | https://registry.opendata.aws/naip/ |
| New Zealand LINZ | 0.05–0.3 | AWS COG + STAC | CC BY 4.0 | Y / Y | https://registry.opendata.aws/nz-imagery/ |
| Ontario | 0.16–0.5 | catalogue | OGL-Ontario† | Y / Y | https://data.ontario.ca/dataset/open-ontario-imagery |
| Restricted or unclear | | | Norway Norge i bilder (download gated), Denmark (licence text not found), Japan GSI (mixed sources), South Africa NGI (no licence stated), Flanders (mixed wording) | | |

No genuinely open sub-metre national programme was found for Rwanda, Kenya, Brazil or India.

## Labelled datasets relevant to boundary delineation

| Dataset | Imagery | Labels | Licence | URL |
|---|---|---|---|---|
| Fields of The World | Sentinel-2 10 m | field polygons, 48 countries incl. Croatia (2023) | per country; most open, some NC (Latvia, Portugal, Lithuania) | https://source.coop/kerner-lab/fields-of-the-world |
| AI4Boundaries (JRC) | S2 10 m + 1 m orthophoto | field boundaries, EU | EC reuse with acknowledgement | https://data.jrc.ec.europa.eu/dataset/0e79ce5d-e4c8-4721-8773-59a4acf2c9c9 |
| EuroCrops | none (vectors) | EU parcel declarations | CC BY-SA 4.0 | https://zenodo.org/records/8229128 |
| FLAIR | IGN 0.20 m | land cover, France | Licence Ouverte 2.0 | https://ignf.github.io/FLAIR/ |
| OpenEarthMap | 0.25–0.5 m | land cover | CC BY-NC-SA default | https://zenodo.org/records/7223446 |
| OpenAerialMap | drone, 0.02–0.3 | patchy global | CC BY 4.0 (per upload unverified) | https://api.openaerialmap.org/meta |

## Best candidates for the next benchmarks

Open sub-metre imagery and open cadastral parcels in the same place, so a model can be scored against truth:

1. France: BD ORTHO 0.20 m + Etalab cadastre (licence text not yet fetched).
2. Netherlands: Luchtfoto 0.08/0.25 m + Kadastrale Kaart (CC BY 4.0 per PDOK metadata).
3. New Zealand: LINZ 0.05–0.3 m + NZ Primary Parcels (CC BY 4.0).
4. Spain: PNOA 0.25 m + Catastro INSPIRE parcels (reuse licence to verify) — the Csa city of PLAN.md step 8.
5. Slovenia: GURS DOF025 0.25 m + GURS cadastre — Ljubljana, step 8.
6. Satellite cross-check: Satellogic EarthView 1 m (CC BY 4.0) wherever its 2022 captures overlap one of these.
