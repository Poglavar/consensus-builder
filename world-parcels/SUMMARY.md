# World parcel research summary

Generated from `registry.json` (updated 2026-09-29). A city sample proves only a bounded response, never full coverage; many negatives are network-limited (hosts unreachable from the research environment) and are **not** proof that no source exists.

## Top 200 cities by status

| Status | Cities |
| --- | ---: |
| `no_verified_open_endpoint_after_attempts` | 89 |
| `temporarily_unavailable` | 48 |
| `verified_sample_partial_coverage` | 26 |
| `verified_sample_city_scope` | 22 |
| `no_verified_sample_candidate_countrywide` | 6 |
| `no_verified_sample_candidate_citywide` | 5 |
| `verified_sample_county_scope` | 4 |

## Cities with a verified parcel sample

| Rank | City | Status | Source | Source scope |
| ---: | --- | --- | --- | --- |
| 2 | Dhaka, BD | `verified_sample_partial_coverage` | Bangladesh DLRS online land-record survey sheets | Surveyed mouzas available through the official selector; coverage is incomplete and must be checked per mouza |
| 3 | Tokyo, JP | `verified_sample_partial_coverage` | MOJ registry-map polygons converted by Esri Japan | Tokyo 23 wards plus selected Aichi and Fukuoka areas; only the Tokyo sample is verified here |
| 13 | São Paulo, BR | `verified_sample_partial_coverage` | São Paulo municipal fiscal lots | São Paulo municipality only; downloaded GeoJSON response is capped at 50,000 of 1,688,215 reported features |
| 22 | New York City, US | `verified_sample_city_scope` | New York City Digital Tax Map tax-lot polygons | New York City five boroughs; wider metro area and United States excluded |
| 25 | Osaka, JP | `verified_sample_partial_coverage` | MOJ registry-map 2026 polygons converted by Geospatial Information Center | Municipality and ward packages across Japan, public-coordinate sheets only; only Osaka Chuo ward sampled here |
| 27 | Los Angeles, US | `verified_sample_county_scope` | Los Angeles County Assessor parcels (public MapServer) | Los Angeles County only; neighbouring counties in the urban agglomeration are separate sources |
| 28 | Luanda, AO | `verified_sample_partial_coverage` | Luanda property polygons (ArcGIS Online, Luanda_AGT_Oficial_2_gdb) | Luanda area (Maianga sampled); layer count 2,239,859; publisher, completeness and authority unverified |
| 31 | Bogotá, CO | `verified_sample_city_scope` | Bogota D.C. cadastral lots (UAECD catastro/lote MapServer) | Distrito Capital de Bogota only; neighbouring municipalities and the rest of Colombia are separate sources |
| 32 | Lima, PE | `verified_sample_partial_coverage` | Lima lots (SEDAPAL-derived, ArcGIS Online 'lotes') | Parts of Lima (San Juan de Lurigancho sampled; central Lima test box empty); 276,848 lots |
| 35 | Rio de Janeiro, BR | `verified_sample_partial_coverage` | Lotes (2013) - Quadras_Lotes_Edificacoes FeatureServer layer 1, Prefeitura do Rio (DATA.RIO) | Municipality of Rio de Janeiro; physical lots restituted from the 2013 aerial survey (updated 2019 in places) |
| 36 | Paris, FR | `verified_sample_city_scope` | API Carto module Cadastre (IGN Geoplateforme), parcelle endpoint, based on Etalab PCI Vecteur cadastre | France (metropolitan and overseas); Paris arrondissement 5 sampled |
| 40 | Bandung, ID | `verified_sample_partial_coverage` | Peta Penggunaan dan Kepemilikan Tanah (Hak Milik) Skala 1:5000, Jawa Barat sublayer (Satu Peta Perizinan dan Pertanahan) | Land parcels with land-right type (Hak Milik etc.) for Jawa Barat; the same MapServer has sublayers for 15 provinces |
| 41 | Kuala Lumpur, MY | `verified_sample_partial_coverage` | Lot_Kadaster_MIL1 FeatureServer layer 7 (LOT_DAERAH_PETALING), JPS Selangor GIS | Selangor state cadastral lots by district (9 district layers); Petaling district layer has 63,603 features. Covers the Selangor part of the Kuala Lumpur agglomeration, NOT the Kuala Lumpur Federal Territory |
| 49 | Nagoya, JP | `verified_sample_partial_coverage` | MOJ registry-map polygons converted by Esri Japan | Tokyo 23 wards plus selected Aichi and Fukuoka areas; only the Tokyo sample is verified here |
| 50 | Johannesburg, ZA | `verified_sample_city_scope` | South Africa Cadastre (Erven layer), GISCOE | South Africa erven (claimed); verified around Johannesburg and now Durban |
| 54 | Surabaya, ID | `verified_sample_partial_coverage` | Peta Penggunaan dan Kepemilikan Tanah (Hak Milik) Skala 1:5000 - Jawa Timur (BIG Satu Peta PUBLIK/PERIZINAN_DAN_PERTANAHAN layer 12) | East Java province layer, but sampled coverage is partial (see coverageAssessment) |
| 58 | Santiago, CL | `verified_sample_partial_coverage` | Predios por comuna en Santiago Metropolitana (Predios_Santiago FeatureServer) | Predio polygons for communes of the Santiago metropolitan area (item extent about -70.87,-33.65 to -70.15,-33.29); reference date 2026-04-30 |
| 72 | Madrid, ES | `verified_sample_city_scope` | Direccion General del Catastro - INSPIRE Cadastral Parcels download service (ATOM) | Spain except Basque Country and Navarre (which run their own cadastres) per Catastro's INSPIRE description; not verified here beyond Madrid |
| 74 | Toronto, CA | `verified_sample_city_scope` | City of Toronto Property Boundary (Municipal Parcel Fabric) | City of Toronto |
| 78 | Sri Jayawardenepura Kotte - Colombo, LK | `verified_sample_partial_coverage` | Sri Lanka NSDI Planning Cadastre - Parcel Fabrics | Partial: districts covered by the parcel fabric |
| 83 | Chattogram, BD | `verified_sample_partial_coverage` | Bangladesh DLRS online land-record survey sheets | Surveyed mouzas available through the official selector; coverage is incomplete and must be checked per mouza |
| 84 | Singapore, SG | `verified_sample_city_scope` | SLA Cadastral Land Parcel (data.gov.sg) | Singapore (island-wide surveyed land lots) |
| 90 | Tamar (Hong Kong), HK | `verified_sample_city_scope` | Lot Index API (iC1000 Digital Land Boundary Map) | Hong Kong SAR lots (LOT, GLA, STT types) |
| 92 | Santo Domingo, DO | `verified_sample_partial_coverage` | Atlas Registro Inmobiliario GeoServer (ParcelasHistoricas, Aprobados) | Distrito Nacional and other provinces; extent per layer not fully checked |
| 93 | Cape Town, ZA | `verified_sample_city_scope` | Land Parcels (City of Cape Town Open Data Portal) | City of Cape Town metropolitan municipality |
| 103 | Bamako, ML | `verified_sample_partial_coverage` | NINACAD parcel layer (sifMali:parcelle) via SPRDF GeoServer | Mali (layer WGS84 extent lon -9.46..-6.05, lat 12.03..13.72: Bamako district and surrounding Koulikoro/Segou areas); coverage of other regions unverified |
| 107 | Sydney, AU | `verified_sample_partial_coverage` | NSW Cadastre (Lot layer), Spatial Services / SIX Maps | New South Wales state lots (plan/section/lot extents) |
| 115 | Houston, US | `verified_sample_county_scope` | HCAD Parcels (Harris County Appraisal District GIS) | Harris County, Texas (layer copyright HCAD GIS Division) |
| 124 | Recife, BR | `verified_sample_city_scope` | Lotes (Area urbana dataset), Portal de Dados Abertos da Cidade do Recife | Municipality of Recife, ~114k lot polygons |
| 125 | Chicago, US | `verified_sample_county_scope` | ccgisdata - Parcel 2021 (Cook County Open Data, dataset 77tz-riq7) | Cook County, Illinois (includes City of Chicago) |
| 127 | Melbourne, AU | `verified_sample_partial_coverage` | Vicmap Property - Property Map Polygons (PROPERTY_MP), FeatureServer layer 0 | State of Victoria property polygons (covers Melbourne) |
| 129 | Ankara, TR | `verified_sample_city_scope` | TKGM Parsel Sorgu (MEGSIS) web API | Turkey-wide viewer backend (only Ankara sampled here) |
| 133 | Savar, BD | `verified_sample_partial_coverage` | Bangladesh DLRS online land-record survey sheets | Surveyed mouzas available through the official selector; coverage is incomplete and must be checked per mouza |
| 135 | Lusaka, ZM | `verified_sample_partial_coverage` | Lusaka_parcels_creation FeatureServer, layer 0 'Parcels_Mtendere_East' (ArcGIS Online) | One informal settlement (Mtendere East, Lusaka), 28 polygons |
| 139 | Medellín, CO | `verified_sample_city_scope` | Medellin Catastro - ConsultaOperadorCatastral MapServer, layer 7 'Lote' | Municipality of Medellin (native extent about the municipal area; layer also covers rural lots per description) |
| 145 | Washington, D.C., US | `verified_sample_city_scope` | DC GIS Property and Land, Tax Lots (layer 39) | District of Columbia |
| 149 | Fortaleza, BR | `verified_sample_partial_coverage` | PIRF ZEIS Pici - Lotes (Fortaleza open data) | one special-interest social-housing zone (ZEIS Pici); similar per-ZEIS files exist for Lagamar, Pirambu, Serviluz, Bom Jardim, Dionisio Torres |
| 153 | Durban, ZA | `verified_sample_city_scope` | South Africa Cadastre (Erven layer), GISCOE | South Africa erven (claimed); verified around Johannesburg and now Durban |
| 155 | San Francisco, US | `verified_sample_city_scope` | Land Use / Assessor parcels: Parcels - Active and Retired (DataSF dataset acdm-wktn) | City and County of San Francisco |
| 157 | Guayaquil, EC | `verified_sample_partial_coverage` | Catastro rural y nivel de inundacion Guayaquil (ArcGIS Online feature layer) | Rural predios of Guayaquil canton only (2097 features; layer id 43); zero features in the urban core bbox |
| 170 | Miami, US | `verified_sample_county_scope` | Miami-Dade County GIS MD_PA_PropertySearch, layer 1 (MDC.Parcel_poly) | Miami-Dade County |
| 179 | Yogyakarta, ID | `verified_sample_partial_coverage` | Peta Penggunaan dan Kepemilikan Tanah (Hak Milik) Skala 1:5000, Daerah Istimewa Yogyakarta sublayer (Satu Peta Perizinan dan Pertanahan) | Land parcels with land-right type for Daerah Istimewa Yogyakarta province; same MapServer has sublayers for 15 provinces |
| 181 | Naples, IT | `verified_sample_city_scope` | Cartografia Catastale WFS (INSPIRE cadastral parcels and zoning) | Italian cadastral parcels (CP:CadastralParcel) and zoning (CP:CadastralZoning); service title/abstract suggest national cartography, but only Naples was sampled here |
| 183 | Essen, DE | `verified_sample_city_scope` | WFS NW ALKIS Vereinfacht (Flurstücke, simplified ALKIS) | Cadastral parcels (ave:Flurstueck) of North Rhine-Westphalia (feature types also include buildings, land use, cadastral districts); sample is Essen only |
| 184 | Cali, CO | `verified_sample_city_scope` | IDESC Cali GeoServer, layer catastro:cat_bas_terrenos (cadastral land parcels) | Santiago de Cali municipality |
| 186 | Semarang, ID | `verified_sample_partial_coverage` | Satu Peta (BIG) PERIZINAN_DAN_PERTANAHAN, layer 25 Jawa Tengah of 'Peta Penggunaan dan Kepemilikan Tanah (Hak Milik) 1:5000' | Central Java province, titled Hak Milik parcels only, patchy |
| 188 | Izmir, TR | `verified_sample_city_scope` | TKGM (Tapu ve Kadastro Genel Mudurlugu) cadastre parcel lookup API used by the Parsel Sorgu viewer | Turkey nationwide viewer service; only Izmir (Konak) sampled here |
| 190 | Tel Aviv, IL | `verified_sample_city_scope` | Tel Aviv-Yafo Municipality GIS (IView2 MapServer), layer 524 'Chalkot' (parcels) | Tel Aviv-Yafo municipal area; layer extent about 12 x 14 km in ITM |
| 191 | Birmingham, GB | `verified_sample_partial_coverage` | 'Land Registry Inspire Sites 20211022' public ArcGIS Online FeatureServer layer 0 (third-party copy of HM Land Registry INSPIRE index polygons) | 22,075 polygons in one Midlands extract around Birmingham; not a complete national or city dataset |
| 194 | Milan, IT | `verified_sample_city_scope` | Cartografia Catastale WFS (INSPIRE Cadastral Parcels and Zoning), Agenzia delle Entrate | Italy-wide cadastral map service per operator; only Milan sampled |
| 198 | Cotonou, BJ | `verified_sample_partial_coverage` | e-Foncier GeoServer, workspace efb, layer efb_parcel (Cadastre National du Benin) | digital cadastre parcels; sampled in Cotonou (Littoral) and, with 1 feature, near Seme-Podji (Oueme); extent of national coverage unverified |
| 200 | Curitiba, BR | `verified_sample_city_scope` | GeoCuritiba Mapa Cadastral, layer 15 Lote Cadastral | Municipality of Curitiba (layer native extent spans the city and part of the metropolitan region); one small area sampled |

## Country probes

Question: does each country have a country-wide online cadastre? Statuses come from `research/countries/<ISO2>.json`; the registry normalises labels the evidence did not support (see each entry's `mergeNote`). `countryCoverage` stays empty until a source has an explicit nationwide claim, two distinct verified regions, one schema, and recorded exclusions.

- **`temporarily_unavailable`** (93): AE, AF, AL, BZ, CD, CI, CW, DJ, DZ, EC, ER, ET, FJ, GA, GI, GM, GQ, GT, HN, IQ, IR, IS, JE, JO, KG, KH, KR, KW, KZ, LA, LB, LR, LS, LT, LY, MA, MC, MD, ME, MG, MK, MM, MO, MR, MT, MU, MV, MW, MX, MZ, NA, NE, NI, NP, OM, PA, PE, PG, PH, PS, QA, RS, RU, SA, SB, SD, SK, SL, SN, SO, SR, SS, ST, SV, SY, SZ, TG, TJ, TL, TM, TN, TT, TZ, UA, UG, UZ, VE, VN, VU, XK, YE, ZM, ZW
- **`national_online_cadastre_verified_sample`** (23): AT, BD, BG, CZ, DK, EE, ES, FI, FR, HK, HR, IE, IL, IT, LU, MN, NL, NO, NZ, PL, PY, SI, TR
- **`no_online_cadastre_found`** (20): AO, AZ, BI, BS, BW, CF, CG, CM, CU, EG, EH, GN, GW, HT, KI, KM, KP, PF, TD, WS
- **`partial_or_unofficial_sample`** (14): BB, BR, CH, DO, HU, ID, JP, LK, LV, ML, PT, SG, UY, ZA
- **`national_cadastre_viewer_only`** (14): BJ, BN, BO, BY, CL, CR, CV, CY, GE, GR, GY, JM, NC, RO
- **`subnational_only`** (13): AR, AU, BA, BE, CA, CO, DE, IN, NG, PK, PR, RW, US
- **`national_cadastre_credentialed_or_paid`** (12): AM, BF, BH, BT, CN, GB, GH, KE, MY, SE, TH, TW
- **`covered_by_parent_source`** (5): GF, GP, MQ, RE, YT
