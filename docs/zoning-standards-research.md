<!-- Research record: how land use and land-use regulations (what a city permits) are expressed by data standards worldwide, and what that means for the Permitted layer. Not an implementation decision. -->
# Land use and zoning standards research

Checked **2026-10-26** and **2026-10-30**. This is the project's collected research on how standards express **land use** (what land or a building is for) and **land-use regulations** (what a city permits on a plot: uses, height, storeys, floor-area ratio, coverage, building lines, lot size). It covers 3D city and building models, cadastre and land-administration models, national and international spatial-plan standards, classification systems, US zoning datasets and rule languages. It is research only: it does not select or introduce a new core schema, rule engine, importer, or legal-compliance claim. Items marked *unverified* could not be confirmed from a primary source in the check.

## Summary

- **No international standard expresses a city's permitted building rules as executable data.** INSPIRE codes the kind of rule but leaves the value as provider-defined text; LADM Part 5 is a conceptual model; IFC and IDS describe and check a design, not a city's rules.
- **Several national standards store the rule numbers as typed fields**: Germany (XPlanung), the Netherlands (IMRO, IMOW), Finland (Ryhti), Norway (SOSI Plan), Denmark (Plandata.dk), Japan (PLATEAU `urf:`), and the Australian state of New South Wales (Standard Instrument map layers). France and Croatia regulate the same quantities but store the values as optional attributes or text.
- **The structured standards converge on a small common field set**: coverage, floor-area ratio, storeys, height with its measurement reference, a drawn buildable area or building line, minimum lot size, and permitted/conditional/forbidden uses ([crosswalk](#common-rule-fields-crosswalk)). It is close to the Detached rule's constraints.
- **Everything standardised is for checking a given design.** Deriving the largest permitted form (the permitted envelope) is a different and harder problem that no standard addresses ([checking versus deriving](#checking-a-design-versus-deriving-an-envelope)).

## Practical finding

No reviewed standard is a generally applicable, turnkey, machine-executable zoning law model. The useful distinction is between:

1. **Semantic foundations and exchange models** — identity, source authority, plan version, legal text, geographic applicability, controlled values and quantities; and
2. **An application-specific executable profile** — explicit rule effects, conditions, precedence, measurement bases, temporal applicability and an evaluator for the supported subset.

An app can adopt the first without claiming that the second has been solved. Source-specific adapters remain necessary for NZA/LUL, individual jurisdictions, XPlanung, Dutch plans and IFC.

## Checking a design versus deriving an envelope

Two problems are easily conflated:

- **Checking**: given a design, does it meet the rules? Each rule only needs to be a predicate. This is what IFC-SG/CORENET X, IDS, the ACCORD project and LegalRuleML address.
- **Deriving**: given a plot and its rules, what is the largest form that may be built? This is what the Permitted layer draws. Each rule has to be something a solver can construct geometry from, and the answer is not one shape: coverage, floor-area ratio and height trade against each other, which is why the project has [configurations and the outer bound](vocabulary.md#outer-bound).

For deriving, a mapped rule falls into one of three kinds:

| Kind | Examples | Role |
| --- | --- | --- |
| Generative | Setbacks and yards (also from a height), building lines and drawn buildable areas, height limits and sloped planes, coverage and floor-area budgets, maximum footprint, minimum lot size and frontage (as eligibility) | Shapes the envelope. |
| Check-only | Parking, unit mix and minimum unit size, facade articulation, materials, shade or sunlight tests that need a full design | Tests a particular design; cannot shape an envelope by itself. |
| Not computable | Discretionary judgement ("harmonise with the street"), case-by-case exceptions | Evidence only. |

## Land-use classification

How each standard says what land or a building is for. None of these carries a regulation by itself.

| Standard | Land use | Building use | Notes |
| --- | --- | --- | --- |
| **CityGML 3.0 / 2.0** (OGC) | `luse:LandUse` with `class` (0..1), `function` (0..*), `usage` (0..*), all `gml:CodeType` | Same triple on `Building`/`BuildingPart` | The schema documents `function` as intended purposes and `usage` as actual uses, so the planned/observed split is built in. Code values are left to profiles; no zoning module exists (modules: appearance, bridge, building, cityfurniture, cityobjectgroup, construction, dynamizer, generics, landuse, pointcloud, relief, transportation, tunnel, vegetation, versioning, waterbody). [3.0 LandUse XSD](https://schemas.opengis.net/citygml/landuse/3.0/landUse.xsd), [docs](https://opengeospatial.github.io/CityGML-3.0Encodings/xsd-doc/3.0/landUse). |
| **CityJSON 2.0** | `LandUse` city object (MultiSurface or CompositeSurface), free `attributes` | `Building` attributes, free | Extensions add `+`-prefixed object types, attributes and root properties; regulation would have to live there. [Spec 2.0.1](https://www.cityjson.org/specs/2.0.1/). |
| **Japan PLATEAU** (CityGML profile with the i-UR extension) | `luse:class` from `Common_landUseType` (201 paddy … 211 residential, 212 commercial, 213 industrial … 231 unknown); `uro:LandUseDetailAttribute` adds the city's own category and observed coverage and floor-area ratios | `uro:BuildingDetailAttribute.detailedUsage`: 401 business, 402 commercial, 411 detached house, 412 apartments, 413–415 mixed, 421 government, 422 education and welfare, 441 factory … refined to 4 and 6 digits | Also carries regulation, see [Japan](#japan-plateau-and-national-land-numerical-information). [detailedUsage list](https://www.mlit.go.jp/plateaudocument/toc4/toc4_02/toc4_02_04/toc4_02_04_02/BuildingDetailAttribute_detailedUsage_xml). |
| **IFC 4.3** (buildingSMART, ISO 16739) | `IfcSite`, classified through `IfcClassificationReference` | `Pset_BuildingCommon.OccupancyType`, a free label "according to the presiding national building code" | `IfcZone` groups spaces without geometry; `IfcSpatialZone` types (construction, fire safety, occupancy, reservation …) have no zoning type. |
| **OpenStreetMap** | `landuse=*`: "the primary use of land by humans", as observed | `building=*` (structure type), `building:use=*` (present use) | The wiki says not to tag land a plan zones but that is not yet used that way; zoning "can't be readily observed on the ground". `zoning_code` exists with undefined status and no use; `zoning` has no page. Lifecycle prefixes (`proposed:`, `planned:`, `construction:`) mark future features, not permissions. [Key:landuse](https://wiki.openstreetmap.org/wiki/Key:landuse), [Parcel](https://wiki.openstreetmap.org/wiki/Parcel). |
| **Overture Maps** (schema 2.0.0) | Base theme `land_use` ("predominant human use", sourced from OSM): 25 subtypes, about 120 classes | `subtype` (13: residential, commercial, industrial, civic, education, medical …) and `class` (about 85, OSM `building=*` values) | No zoning or planned use. [land_use](https://docs.overturemaps.org/schema/reference/base/land_use/). |
| **ALKIS** (German cadastre, AAA model) | "Tatsächliche Nutzung": `AX_Wohnbauflaeche` (41001), `AX_IndustrieUndGewerbeflaeche` (41002), `AX_FlaecheGemischterNutzung` (41006) …, dominant use at survey time | `AX_Gebaeude.gebaeudefunktion`: 1000 residential, 1100 mixed with housing, 2000 business, 3000 public … | No zoning plans; `AX_BauRaumOderBodenordnungsrecht` holds only procedure flags (readjustment, redevelopment). [NRW catalogue 7.1](https://opendata.stadt-muenster.de/sites/default/files/ALKIS-Objektartenkatalog-NRW-V7.1.pdf). |
| **OGC LandInfra** | `LandParcel.currentLandUse` and `plannedLandUse`, coarse jurisdiction enumerations; `Easement.permittedUse` as text | `CondominiumUnit.condominiumUseType` | No regulation content. [15-111r1](https://docs.ogc.org/is/15-111r1/15-111r1.html). |
| **INSPIRE HILUCS** (EU) | Mandatory on existing and planned land use; 3 levels, 98 values (6 / 27 / 65): primary, secondary and tertiary production, transport and utilities, residential, other | — | [Code list](https://inspire.ec.europa.eu/codelist/HILUCSValue/HILUCSValue.en.json). |
| **APA LBCS** (US) | Five independent dimensions, each a 4-digit hierarchy: Activity, Function, Structure, Site, Ownership (the same number means different things per dimension) | Structure dimension (1100 single-family, 1200 multifamily …) | Existing use only. Regrid maps county codes to it by hand. [LBCS](https://www.planning.org/lbcs/). |
| **NYC MapPLUTO** (de facto) | `LandUse`, the city's own 11 categories | — | [Data dictionary](https://www.nyc.gov/assets/planning/download/pdf/data-maps/open-data/pluto_datadictionary.pdf). |

The project's own six building uses already map from CityGML/ALKIS codes and OSM/Overture values at import ([building use](vocabulary.md#building-use)); the same crosswalk approach extends to any list above.

## Regulation standards

### Rule numbers as typed fields

#### Germany: XPlanung (XPlanGML)

- Current versions 6.1 and 6.0.2; Hamburg serves 5.1. [6.1 XSDs and code lists](https://registry.gdi-de.org/schemas/de.xleitstelle.xplanung/6.1/), [6.1 release](https://xleitstelle.de/node/196).
- `BP_BaugebietsTeilFlaeche` (a zone of a local plan): coverage `GRZ`, floor-area ratio `GFZ`, building-mass ratio `BMZ`, each with `min`/`max` and an exception value (`_Ausn`); absolute floor area, footprint and volume (`GF`, `GR`, `BM`); storeys `Z`, `Zmin`, `Zmax`, `Zzwingend` (required, not only allowed), `Z_Staffel`, `Z_Dach`, basement storeys `ZU*`; `MaxZahlWohnungen`; plot width and depth `Bmin/Bmax`, `Tmin/Tmax`.
- Use: `allgArtDerBaulNutzung` (5 codes) and `besondereArtDerBaulNutzung` (16 BauNVO codes: 1100 WR, 1200 WA, 1500 MI, 1550 MU, 1600 MK, 1700 GE, 1800 GI, sondergebiete …); `bauweise` (open, closed, deviating) and `bebauungsArt` (detached, semi-detached, groups).
- Height is not a zone field: any object carries `hoehenangabe` (`XP_Hoehenangabe`: `h`, `hMin`, `hMax`, `hZwingend`, a reference point `bezugspunkt` such as eaves, ridge or top edge, and `hoehenbezug`, absolute datum or relative to terrain or street). `BP_HoehenMass` is a separate feature type.
- Building lines are drawn: `BP_BauGrenze` (building limit, may not be crossed) and `BP_BauLinie` (building line, must be built on), with `bautiefe` and storey ranges; `BP_UeberbaubareGrundstuecksFlaeche` is the buildable area.
- Obligation: IT-Planungsrat decision 2017/37 made XPlanung binding for vector exchange of plans, but nobody is obliged to produce vector plans and old plans need not be converted. The building-code amendment of 2026 (cabinet 2026-05-27) adds an explicit duty, planned from 2027-01-01. [Overview](https://www.goerg.de/de/aktuelles/veroeffentlichungen/29-09-2026/die-baugb-novelle-2026-schneller-digitaler-und-kommunaler).
- Open vector data exists mainly in Hamburg and Freiburg; most other plans are published as an outline and a scan. See [Germany in depth](#germany-in-depth) for the legal layers, the data by state and what can be computed.
- XBau is the related standard for building-permit applications, not a zoning-rule model.

#### Netherlands: IMRO2012 and the Omgevingswet models

- IMRO2012 (legacy and transitional): `Bestemmingsvlak` carries the use (`bestemmingshoofdgroep`, `naam`); `Bouwvlak` is the buildable area; `Maatvoering` is a polygon with `maatvoeringInfo` pairs of `waarde` and `waardeType`, the latter from an open list: maximum bouwhoogte and goothoogte (m), maximum aantal bouwlagen, maximum bebouwingspercentage (%), maximum bebouwd oppervlak and vloeroppervlakte (m²), maximum volume (m³), maximum aantal wooneenheden. There is no floor-area ratio. [IMRO](https://docs.geostandaarden.nl/ro/imro/).
- Since the 2024 Omgevingswet: STOP/TPOD publish the legal text and IMOW annotates it. `Omgevingsnorm` and `Omgevingswaarde` (both `Norm`) carry `type`, `eenheid` and `normwaarde` with a quantitative value (REAL) or qualitative text per location; a quantitative value requires a unit. `Activiteit` and `Gebiedsaanwijzing` classify without numbers. Whether the norm-type list fixes names such as "maximum bouwhoogte" is *unverified*. [IMOW](https://docs.geostandaarden.nl/ow/def-im-imow-20250711/), [TPOD omgevingsplan](https://docs.geostandaarden.nl/tpod/def-st-TPOD-OP-20251010/), [overview](https://iplo.nl/digitaal-stelsel/aansluiten/standaarden/stop-tpod-imop/), [schemas and examples](https://github.com/Geonovum/TPOD).
- Availability: PDOK says its Ruimtelijke Plannen services are incomplete since the Omgevingswet and points to the DSO APIs. [PDOK](https://www.pdok.nl/introductie/-/article/ruimtelijke-plannen).

#### Finland: Ryhti and the national plan data model

- The data model (`rytj-kaava`) is set in law by decree 311/2024, in force since 2024-06-11. A plan has plan objects; each carries plan regulations with a mandatory regulation code and a typed value (text, number, range or code).
- Codes with numeric values include allowed floor area (`sallittuKerrosala`, k-m²), allowed volume (m³), efficiency ratio (`tehokkuusluku`), coverage (`rakentamisenSuhdeAlueenPintaAlaan`, %), storeys (`maanpaallinenKerroslukuLuku`, number or range), maximum facade height (`julkisivunEnimmaiskorkeus`), roof-top level, buildable area (`rakennusala`) and the share of floor area per use.
- Rollout to municipalities runs 2025–2028; coverage figures and an open plan API are *unverified*. [Decree](https://finlex.fi/api/media/statute/4430/mainPdf/main.pdf), [data model](https://tietomallit.suomi.fi/model/rytj-kaava), [Ryhti](https://ryhti.syke.fi/).

#### Norway: SOSI Plan

- `RpArealformålOmråde` carries a land-use purpose code and `utnytting` entries: `utnyttingstype` (16 %-BYA coverage, 15 BYA m², 17 BRA floor area, 18 %-BRA, plus legacy types) with `utnyttingstall` and a minimum.
- Building limit (1211) and building line (1212) are drawn `RpJuridiskLinje`; `RpRegulertHøyde` is a regulated height line. Maximum building height is probably in the plan text (*unverified*). [Specification](https://register.geonorge.no/data/documents/Produktspesifikasjoner_reguleringsplaner_v2_sosi-prodspek-del-3-2-reguleringsplan_.pdf).

#### Denmark: Plandata.dk

- Local plans and their sub-areas carry use codes (`ANVGEN`, `ANVKONKRET`), zone status, coverage `BEBYGPCT` with its basis `BEBYGPCTAF`, `M3_M2`, `MAXETAGER`, `MAXBYGNHJD`, and the same per use for up to ten uses; building fields can carry floor area, storeys or height. Complex plans set `KOMPLEKS` and rely on text.
- Municipalities must report these for a plan to take effect. Current service field names are *unverified* (the GeoServer timed out). [Model description](https://journals.aau.dk/index.php/gfp/article/download/2665/6151/23908).

#### Japan: PLATEAU and National Land Numerical Information

- PLATEAU's `urf:` module holds 28 city-planning feature types. `urf:UseDistrict` (use district): `function` from the 13 statutory districts, `floorAreaRate` (required, integer %), `buildingCoverageRate`, `minimumSiteArea`, `wallSetbackDistance`, `buildingHeightLimits`, `setbackRestrictions`, `frontRoadRestrictions`, `northDirectionRestrictions`, `shadeRegulation` and more. `urf:HighLevelUseDistrict` adds minimum and maximum floor-area ratio, maximum coverage, minimum building area and setback size. Others include `HeightControlDistrict`, `SpecialUseDistrict` and `ExceptionalFloorAreaRateDistrict`. [UseDistrict](https://www.mlit.go.jp/plateaudocument/toc4/toc4_10/toc4_10_03/toc4_10_03_03/_0d114162-39ec-d50a-f744-869887efb4ac), [HighLevelUseDistrict](https://www.mlit.go.jp/plateaudocument01-02/contents/complex/urf_HighLevelUseDistrictType.html).
- This is the one zoning encoding in production use inside CityGML, as an extension. Which uses each district permits is not in these fields (it is in the Building Standards Act; *unverified* where it is encoded, if anywhere).
- National Land Numerical Information A29 (use districts, latest v2.1, FY2019) carries the district code and name, coverage `A29_006` and floor-area ratio `A29_007` (9999 unknown), digitised at 1:25,000; v1.0 states non-commercial terms. [A29](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-A29.html).

#### Australia: New South Wales Standard Instrument

- Councils choose zones from a fixed list (R1–R5, RU1–RU6, E1–E5, SP1–SP3, C1–C4, MU1 …) and cannot add their own. The live statewide service also still carries legacy codes from older plans (95 distinct codes).
- Each control is its own map layer: floor-space ratio (`FSR`), height of buildings (`MAX_B_H`, `MAX_B_H_M`, or `MAX_B_H_RL` as an absolute level, with `UNITS`), minimum lot size (`LOT_SIZE`), zoning (`SYM_CODE`, `LAY_CLASS`), all with plan name, commencement date and clause reference. [EPI primary planning layers](https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/EPI_Primary_Planning_Layers/MapServer/layers?f=json).
- Permitted uses are only in the written land-use table of each plan. Victoria's planning datasets exist under CC BY 4.0; numeric fields there are *unverified*. There is no national standard.

#### Singapore: URA Master Plan

- The Master Plan 2019 land-use layer (GeoJSON, open licence) has `LU_DESC` and gross plot ratio `GPR` (stored as a string). URA states the plot ratio is only the maximum and must be read with the written statement. Height is not in this layer. [Dataset](https://data.gov.sg/dataset/master-plan-2019-land-use-layer).

### Rules typed but values loose

#### INSPIRE Planned Land Use (EU)

- Binding interoperability model: [Regulation 1089/2010, consolidated](https://eur-lex.europa.eu/eli/reg/2010/1089/2023-11-19/eng); [technical guidelines](https://knowledge-base.inspire.ec.europa.eu/publications/inspire-data-specification-land-use-technical-guidelines_en) (CC BY 4.0); [PLU XSD](https://inspire.ec.europa.eu/schemas/plu/4.0/PlannedLandUse.xsd).
- `SpatialPlan` (level, plan type, process step), `ZoningElement` (`hilucsLandUse`, `specificLandUse`, `regulationNature`, validity dates), `SupplementaryRegulation`, `OfficialDocumentation`.
- The kind of building rule is coded in `SupplementaryRegulationValue` (157 values), group `6_RegulationsOnBuildings`: building line, boundary line, building height regulation, building density regulation, minimum housing size. `RegulationNatureValue` has 5 values (binding for developers, generally binding, non-binding …).
- The value goes in `dimensioningIndication` (0..*, voidable): typed integer, real, measure or character, but what it measures is the free text `indicationReference`. FAR, setbacks, overlay precedence and measurement bases are not standardised. Mappings from XPlanung treat these as optional. How often providers fill them is *unverified*.

#### France: CNIG standard for local plans (PLU/PLUi, v2024-01)

- `ZONE_URBA.TYPEZONE` (U, AU, A, N) and, well structured, permitted uses as allowed, conditional and forbidden destination codes (`DESTOUI`, `DESTCDT`, `DESTNON`).
- Prescriptions (`PRESCRIPTION_SURF/LIN/PCT`) code the rule type: setback from roads (15-xx), ground coverage minimum and maximum (38-01/02), height minimum and maximum (39-01/02).
- The numbers are only optional example attributes (`LIB_ATTRn`/`LIB_VALn`, such as `COEF_EMPRISE_SOL_MAX`, `HAUTEUR_METRES_MAX`). The written rules have a separate text-structure standard with no numbers. The national portal (Géoportail de l'Urbanisme) holds about 12,800 plans. [Standard](https://cnig.gouv.fr/IMG/pdf/231220_standard_cnig_plu_v2024-01.pdf).

#### Croatia: planning rulebook and ePlanovi

- The rulebook on spatial plans (NN 152/2023, in force 2024-01-01) requires plans to set, inside construction areas, maximum coverage `kig`, maximum floor-area ratio `kis` (optionally above and below ground), maximum gross floor area, maximum facade height `H`, total height and storeys.
- Plans are made in ISPU's ePlanovi module, and the plan's original is its vector, alphanumeric and metadata set. Article 7(2), however, has the rules drawn as areas in layer `KN-3-1` and entered **as text in the attribute table**. Whether the annexes define numeric attributes is *unverified*.
- Publication is raster map services; there is no open vector service of plan rules. See [Croatia in depth](#croatia-in-depth). [NN 152/2023](https://narodne-novine.nn.hr/clanci/sluzbeni/2023_12_152_2228.html).

#### Slovenia: OPN shapefile standard and the national planning WFS

- A mandated digital format (OPIA technical rules) with open national services; the rule columns exist but are optional, typed as text and filled with prose. See [Slovenia in depth](#slovenia-in-depth).

#### New Zealand: National Planning Standards (2019)

- Councils may use only the zones in the zone framework (standard 8), in a fixed order, with fixed spatial layer types (standard 12). The standards fix zone names and purposes, not numbers: each council writes its own rules. The zone list is *unverified* (the ministry's site blocked fetching).

### Conceptual and international models

#### LADM (ISO 19152)

- [Part 1, 2024](https://www.iso.org/standard/81263.html): parties, spatial units, rights/restrictions/responsibilities (RRRs) and sources. The project uses its concepts for parcels and owners.
- [Part 5, Spatial Plan Information, 2025-08](https://www.iso.org/standard/81267.html): the normative text is sold (CHF 159; no free full text found). From the drafts ([2022 workshop](https://fig.net/resources/proceedings/2022/Downloads/Comm_3_8_workshop/Extending%20LADM%20with%20Spatial%20Plan%20Information%20-%2019152-5_v2_Abdullah.pdf), [FIG 2023](https://www.fig.net/resources/proceedings/fig_proceedings/fig2023/papers/ts03i/TS03I_lemmen_van_oosterom_et_al_12245.pdf)): `SP_PlanUnit` (smallest homogeneous 2D/3D area with a function; `maxHeightIndications`, `maxAreaIndications`, `maxVolumeIndications`, `unitIndications`, `typeOfBuildingIndications`), `SP_PlanBlock` (expected land use, protected sites, restriction zones), `SP_PlanGroup`, `SP_Permit` with `SP_PermitType` allowed, conditional, restricted. No floor-area ratio or coverage attribute in the drafts. Final names are *unverified*.
- Useful for plan identity, legal lineage and the three-state permit; it defines no constraint expressions, precedence or evaluator.

### Checking a design: building-information standards

- **IFC 4.3** `Pset_SiteCommon` has four single values per site "according to local building codes": `BuildableArea`, `SiteCoverageRatio`, `FloorAreaRatio`, `BuildingHeightLimit`, plus `TotalArea`. There are no setbacks or permitted uses. `Pset_LandRegistration` holds only land and title identifiers. The constraint resource (`IfcConstraint` with hard/soft/advisory grade, `IfcObjective` with a code-compliance qualifier, `IfcMetric` with a benchmark and value) can attach any named limit, but is generic machinery. [IFC 4.3 source](https://github.com/buildingSMART/IFC4.3.x-development), [IFC release database](https://technical.buildingsmart.org/standards/ifc/ifc-schema-specifications/).
- **IFC-SG / CORENET X** (Singapore, soft launch 2023-12): the designer declares the site's master-plan land use (`SGPset_GeographicElement.BroadLandUse`, 32 URA classes) and tags each space's gross floor area with its development use (25 values), use quantum and bonus type. The limits themselves are not in the IFC; URA checks the declaration against its own data. [Mapping file](https://info.corenet.gov.sg/docs/default-source/requirements/industry-mapping-09-2026.xlsx), [overview](https://info.corenet.gov.sg/overview/about-corenet-x/overview-of-corenet-x).
- **IDS 1.0** (final 2024-06): specifications with applicability and requirement facets (entity, classification, attribute, property, material, part-of) and value restrictions. It checks that data exist and fall in range; it computes nothing. [IDS](https://github.com/buildingSMART/IDS).
- PLATEAU's `uro:IfcPsetSiteCommon` carries the IFC site limits into CityGML.

### United States

There is no national zoning data standard. Washington's statewide atlas says local publication is not standardised. [Washington Zoning Atlas](https://www.commerce.wa.gov/growth-management/data-research/waza/).

| Source | Kind | Rule fields |
| --- | --- | --- |
| National Zoning Atlas | Research dataset, see [below](#national-zoning-atlas-and-land-use-labs) | About 200 characteristics per district; per housing type (1, 2, 3, 4+ family): min lot, max density, front/side/rear setbacks, coverage (buildings; buildings and impervious), parking, height (storeys and feet), FAR, min unit size. Numbers are strings and often bucketed. |
| [Regrid standardized zoning](https://support.regrid.com/docs/standardized-zoning-schema) | Vendor schema | 26 fields: `zoning_type`, `zoning_subtype`, permitted uses (as of right, conditional), `min_lot_area_sq_ft`, `min_lot_width_ft`, `max_building_height_ft`, `max_far`, front/rear/side setbacks, `max_coverage_pct`, `max_impervious_coverage_pct`, landscaped and open space, `max_density_du_per_acre`, `zoning_data_date`. No parking. |
| [NZLUD](https://github.com/mtmleczko/nzlud) | Research dataset | Measures per municipality, derived by text processing of 2,639 codes; not per district. |
| [Zoning.Space](https://zoningspace.readthedocs.io/en/latest/contributing/) | Volunteer, ODbL | Per-city CSV files with units in column names; setbacks as distance or percent. |
| [Open Zoning Feed Specification](https://research.gsd.harvard.edu/vibelab/2025/08/19/open-zoning-feed-specification-ozfs/) | Proposed standard (Harvard GSD), modelled on GTFS | Ongoing; no public schema found. |
| [Vermont zoning GIS standard 1.2.2](http://vcgi.vermont.gov/sites/vcgiupdate/files/doc_library/02-n-VT_Zoning_GIS_DataSet_Standard1.2.2.pdf) | State standard | Requires only district and note; numbers optional. |
| NYC MapPLUTO | City dataset | `ZoneDist1–4`, `Overlay1–2`, `SPDist1–3`, `LtdHeight`, `ResidFAR`, `CommFAR`, `FacilFAR`, `BuiltFAR`; heights and setbacks stay in the Zoning Resolution. |
| BLDS | Permit data specification (2015) | Building permits, not zoning. |
| Land Use Labs, Gridics, Zoneomics | Commercial APIs | Gridics returns envelope fields (height, setbacks, podium/tower). |

Esri's Local Government Information Model has zoning layers but Esri does not present it as a standard; its fields are *unverified*.

### Rule languages and linked data

| Model | Status | What it covers | Limit |
| --- | --- | --- | --- |
| [LegalRuleML Core 1.0](https://docs.oasis-open.org/legalruleml/legalruleml-core-spec/v1.0/legalruleml-core-spec-v1.0.html) | OASIS standard, 2021 | Constitutive and prescriptive statements, obligation/permission/prohibition, override priority, temporal status, jurisdiction and authority | No zoning use found; no geometry. |
| [Akoma Ntoso / LegalDocML](https://docs.oasis-open.org/legaldocml/akn-core/v1.0/akn-core-v1.0-part1-vocabulary.html) | OASIS standard, 2018 | Structure, metadata and identifiers of legal documents | Not the substance of rules. |
| [Catala](https://arxiv.org/abs/2103.03198) | Research language | Default logic for statutes (tax, benefits) | No planning use found. |
| [ACCORD](https://ace-cae.eu/projects/accord/) | EU Horizon project, 2022–2025 | Rule formalisation tool, ruleset database and compliance-checking services for building permits; pilots in Estonia, Finland, Germany, Spain and the UK | Checking, not deriving; its formalisation format is *unverified*. |
| [GeoSPARQL 1.1](https://www.ogc.org/standards/geosparql/) and [SHACL](https://www.w3.org/TR/shacl/) | OGC and W3C standards | RDF geometry vocabulary and queries; validation of RDF graphs | No zoning concepts, legal time or conflict resolution. |

### No zoning numbers: England

England has no zoning (a discretionary system), so nothing publishes rule numbers. [planning.data.gov.uk](https://www.planning.data.gov.uk/dataset.json) standardises designations and plan metadata in 224 datasets: local plans and their boundaries, article 4 directions and areas, conservation areas, listed buildings, tree preservation zones, green belt, permitted development right codes, and brownfield land with minimum and maximum net dwellings. Its design-code rules carry only names, descriptions and document links. The [Open Digital Planning schemas](https://github.com/theopensystemslab/digital-planning-data-schemas) cover applications, not policy limits.

## Common rule fields crosswalk

The quantities the structured standards share, with the Detached rule's constraint for comparison (`frontend/js/parcel-based.js`, [vocabulary](vocabulary.md#detached-rule)). A dash means the standard has no structured field for it.

| Quantity | XPlanung | IMRO / IMOW | Finland | Norway | Denmark | PLATEAU | NSW | Croatia (text) | Regrid | Detached rule |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Coverage | `GRZ` | bebouwingspercentage | coverage % | `%-BYA` | `BEBYGPCT` | `buildingCoverageRate` | — | `kig` | `max_coverage_pct` | `maxCoverage` |
| Floor-area ratio | `GFZ` | — | `tehokkuusluku` | `%-BRA` | — | `floorAreaRate` | `FSR` | `kis` | `max_far` | `maxFloorAreaRatio` |
| Absolute floor area | `GF` | vloeroppervlakte | `sallittuKerrosala` | `BRA` | — | — | — | GBP | — | — |
| Storeys | `Z`, `Zmin`, `Zmax`, `Zzwingend` | aantal bouwlagen | storeys | — | `MAXETAGER` | — | — | storeys | — | `maxFloors`, `minFloors` |
| Height and its reference | `XP_Hoehenangabe` (`bezugspunkt`, `hoehenbezug`) | bouwhoogte, goothoogte | facade height, roof-top level | regulated height line | `MAXBYGNHJD` | `buildingHeightLimits` | `MAX_B_H`, `MAX_B_H_RL` | `H`, total height | `max_building_height_ft` | `maxHeightM` (relative to ground) |
| Drawn buildable area or line | `BP_BauGrenze`, `BP_BauLinie`, `BP_UeberbaubareGrundstuecksFlaeche` | `Bouwvlak` | `rakennusala` | byggegrense, byggelinje | building fields | — | — | — | — | — |
| Setback distances | `bautiefe` | — | — | — | — | `wallSetbackDistance`, `setbackSize` | — | — | front/side/rear | `minDistance`, `frontSetbackM`, `rearSetbackM`, `setbackHeightRatio`, `fromHeightM` |
| Footprint or building size | `GR` | bebouwd oppervlak | — | `BYA` | — | `minimumBuildingArea` | — | — | — | `maxFootprintAreaM2`, `minFootprintAreaM2` |
| Lot size and width | `Bmin/Bmax`, `Tmin/Tmax` | — | — | — | — | `minimumSiteArea` | `LOT_SIZE` | — | `min_lot_area_sq_ft`, `min_lot_width_ft` | `minPlotAreaM2`, `minFrontageM` |
| Dwellings | `MaxZahlWohnungen` | aantal wooneenheden | — | — | — | — | — | — | density per acre | — |
| Uses | BauNVO codes | bestemming, activiteit | use share of floor area | arealformål | `ANVGEN`, per-use limits | 13 districts | zone code (uses in text) | — | as of right, conditional | building use |
| Exceptions | `_Ausn` values | — | — | — | — | — | — | — | — | `condition` on a configuration |

Patterns across the table:

- Coverage, floor-area ratio, storeys and height are nearly universal; the Detached rule already has them.
- Continental Europe mostly **draws** where building may stand (building limit, building line, buildable area) rather than giving setback distances. The Detached rule has no drawn buildable area or build-to line.
- Several standards have **minimums and required values** (`Zzwingend`, `hZwingend`, building lines that must be built on, minimum floor-area ratio). The Detached rule has a minimum storey count but no required line.
- **Height needs its reference**: eaves, ridge or top edge, and relative to ground, street or an absolute datum (XPlanung `bezugspunkt`/`hoehenbezug`, NSW `_RL`). The Detached rule measures from the ground only.
- **Limits can differ by use** (Denmark's per-use limits, Finland's use share of floor area, NYC's residential/commercial/facility FAR).
- Permitted uses, where structured, take three states: allowed, conditional and forbidden (France, LADM Part 5, Regrid).

## Germany in depth

Checked **2026-10-30**. Law from [gesetze-im-internet.de](https://www.gesetze-im-internet.de/bbaug/) (BauGB) and [BauNVO](https://www.gesetze-im-internet.de/baunvo/); state building codes partly from unofficial mirrors where the official portals could not be read (marked). Data counts are live service queries on that date.

### Who sets what

The system is federal law, state law and a city plan together. No single layer gives the whole answer.

| Layer | Sets |
| --- | --- |
| Federal **BauGB** (building code) | Cities plan "in their own responsibility" (§ 2). Two plan types: the preparatory land-use plan for the whole municipality (Flächennutzungsplan, § 5) and the binding local plan (Bebauungsplan, B-Plan), developed from it (§ 8). § 9 lists what a B-Plan *may* fix. Where a project is allowed: inside a qualified B-Plan (§ 30), in an unplanned built-up area (§ 34), or outside (§ 35). Exceptions and exemptions (§ 31). |
| Federal **BauNVO** (land-use ordinance) | The menu every B-Plan picks from: area types (WR, WA, MI, MU, GE, GI … with their allowed and exceptionally allowed uses, §§ 2–11), the measures (§§ 16–21a: GRZ, GFZ, BMZ, storeys, height), building form (§ 22) and building lines (§ 23). |
| **State building codes** (Landesbauordnungen) | Setbacks (Abstandsflächen), the definition of a full storey (Vollgeschoss) that GFZ and storey counts rely on, fire safety, parking, local design statutes. |
| **City** | Adopts the B-Plan as a by-law (Satzung, § 10) and chooses its content: area type, GRZ/GFZ/BMZ values, storeys and/or heights with their reference points (§ 18 requires them), building form, building lines and limits, its own setbacks (§ 9(1) 2a), excluded or restricted uses (§ 1(4)–(10) BauNVO). |

Only the GRZ (or an absolute footprint) is mandatory in a B-Plan (§ 16(3) BauNVO); storeys or height become mandatory when the townscape would otherwise suffer. Plans older than the BauGB still apply in places: Berlin's 1960 Baunutzungsplan and Hamburg's Baustufenpläne (§ 233(3)).

### How much land a B-Plan covers

There is no national statistic: BBSR states that neither planning procedures nor permit applications are recorded across municipalities ([Analysen KOMPAKT 01/2026](https://www.bbsr.bund.de/BBSR/DE/veroeffentlichungen/analysen-kompakt/2026/ak-01-2026-dl.pdf)). Indications: West Berlin is covered almost entirely by the Baunutzungsplan and B-Plans (Reinickendorf "well under 10 %" unplanned), East Berlin much less ([Drucksache 19/25746](https://pardok.parlament-berlin.de/starweb/adis/citat/VT/19/SchrAnfr/S19-25746.pdf)); Munich claims up to 60 % of housing projects fall under § 34 (an advocacy figure). BBSR's survey finds about 40 % of a city's B-Plans in need of change.

**§ 34** (unplanned built-up area) allows a project that "fits into the character of the immediate surroundings" by use, size, building form and the ground to be built on. Hamburg's guidance ([BPD 2/2001](https://www.hamburg.de/resource/blob/190420/cb1111c73179a6dbdd53171b58fc3e54/bpd-34-baugb-zulaessigkeit-von-vorhaben-innerhalb-der-im-zusammenhang-bebauten-ortsteile-data.pdf)): the surroundings are usually the block; a from–to range is read off the existing buildings for each criterion, excluding outliers; size is judged by visible absolute size (footprint, storeys, height), with GRZ/GFZ secondary; the buildable ground follows existing building fronts and depths. Inside the range a project fits as a rule. Since 2025-10-30, § 34(3b) and § 246e allow deviations for housing with the city's consent until 2030. The inputs are measurable; the choice of surroundings and reference buildings is judgement, and the result is a range, not a shape.

### What changes the arithmetic

- **GRZ (§ 19)**: garages, parking with access, ancillary buildings and underground structures count, and may exceed the GRZ by up to 50 %, capped at 0.8 (§ 19(4), "GRZ II"); the plan may deviate.
- **GFZ (§ 20)** counts the floor area of full storeys only, by outer dimensions; a plan may include rooms in other storeys. A full storey is a **state** definition, e.g. NRW (BauO NRW 2018 § 2(6)): clear height ≥ 2.30 m over more than ¾ of the storey below (NRW has had four definitions); Baden-Württemberg: top more than 1.4 m above mean ground, ≥ 2.30 m clear, top storeys under ¾ excluded; Hamburg: ceiling top more than 1.40 m above mean ground, ≥ 2.30 m, roof storeys need ⅔. Bavaria dropped the term in 2008 and keeps the old one for BauNVO purposes (Art. 83(6) BayBO; wording *unverified*). State rows are from mirrors (*unverified* against the official text).
- **§ 17 values** per area type (e.g. WA 0.4/1.2, MU 0.8/3.0, MK 1.0/3.0, GE/GI 0.8/2.4) have been guidance (Orientierungswerte) rather than caps since 2021-06-23.
- **Heights (§ 16, § 18)**: eaves, ridge or total height, always with the plan's reference point; binding values allow only minor deviation.
- **Building form (§ 22)**: open (side spacing, each building or group at most 50 m), closed (no side spacing), or as the plan defines.
- **Building lines (§ 23)**: a Baulinie must be built on, a Baugrenze may not be crossed, a Bebauungstiefe is measured from the street line; minor projections allowed; ancillary buildings may stand outside unless the plan excludes them.
- **The BauNVO version is per plan.** A plan is read under the version in force when it was publicly displayed (transitional §§ 25a–25e), and the version changes the counting ([Munich's comparison sheets](https://lhm.muenchen.swm.de/dam/jcr:ad9f5a79-5892-4b3b-9681-28aabac8e382/BauNVO_1990_2017_2021.pdf)):

| Version | Applies to plans displayed | Counting |
| --- | --- | --- |
| 1962 | 1962-08-01 to 1968-12-31 | Ancillary buildings not in the footprint; floor area includes habitable rooms in non-full storeys. |
| 1968 / 1977 | 1969-01-01 to 1990-01-26 | As 1962, plus a garage allowance (§ 21a). |
| 1990 / 2017 | from 1990-01-27 | Ancillary buildings, underground garages and access count in the footprint (GRZ II); floor area counts full storeys only. |
| 2021 | from 2021-06-23 | § 17 values become guidance. |

The state's full-storey definition is likewise the one in force at the plan's display or adoption (courts differ; *unverified* which). XPlanung carries `versionBauNVO` on the plan.

### Setbacks by state

Setbacks are state law and apply whatever the B-Plan says, unless the plan fixes building lines and limits that require or allow building closer, or sets its own depths. Model building code (MBO § 6): 0.4 H, at least 3 m; 0.2 H in commercial and industrial areas; a roof up to 70° adds ⅓ of its height to H, a steeper one all of it.

| State | Depth / minimum | GE / GI | Roof added to H | Notes |
| --- | --- | --- | --- | --- |
| Bavaria (official text) | 0.4 H / 3 m | 0.2 H | ≤ 70° ⅓, > 70° full | Since 2021-02-01; cities over 250,000 inhabitants may keep 1 H where the surroundings are small buildings (Art. 6(5a)); which cities is *unverified*. |
| Berlin | 0.4 H / 3 m | 0.2 H | H to the roof surface point by point (*unverified*) | Small residential buildings: 3 m. |
| Hamburg | 0.4 H / 2.5 m | 0.2 H | < 70° ⅓ | |
| NRW | 0.4 H / 3 m | 0.2 H; MK 0.25 H | > 45° ⅓, > 70° full | |
| Baden-Württemberg | 0.4 H / 2.5 m (2 m for walls ≤ 5 m) | 0.125 H | > 45° ¼, > 70° full | Mixed and urban areas 0.2 H. |
| Lower Saxony | 0.4 H / 3 m (since 2024-07-01; was 0.5 H) | 0.2 H | H at each point | |
| Hesse | 0.4 H / 2.5 m | 0.2 H | 45–70° ⅓, > 70° full | |
| Saxony | 0.4 H / 3 m | 0.2 H | < 70° ⅓ | Small buildings: 3 m. |

All but Bavaria from mirrors ([MBO](https://bauministerkonferenz.de/Dokumente/42323530.pdf), [BayBO Art. 6](https://www.gesetze-bayern.de/Content/Document/BayBO-6)); the other eight states were not checked.

### Discretion

- **Exceptions** (§ 31(1)): only those the plan names, e.g. the uses each area type lists as exceptionally allowed (WA: hotels, administration, filling stations …).
- **Exemptions** (§ 31(2)): where the plan's basic intent is untouched and the public interest, urban acceptability or unintended hardship justifies it, weighing neighbours.
- **§ 33**: projects under a plan still in preparation.
- **§ 15 BauNVO**: an allowed use can still be refused for its number, location, size or nuisance (consideration of neighbours).
- No figures exist on how many permits rely on exceptions or exemptions.

### XPlanung: organisation, tools and data

- Maintained by the **XLeitstelle Planen und Bauen** at Hamburg's surveying agency (LGV), a federal–state body that also maintains XBau. [XPlanung](https://xleitstelle.de/xplanung). Versions 3.0 to 6.1; major versions break compatibility. No version 7 found.
- A file holds `BP_Plan` → `BP_Bereich` → plan features; text rules in `XP_TextAbschnitt` (free text, linked by `refTextInhalt`); the scanned plan as `XP_ExterneReferenz`; amendments link to the plan they amend (`aendertPlan`).
- **Outline-and-scan ("Teilvektor") versus full vector ("Vollvektor")**: a conformant file may hold only the plan outline, a georeferenced scan and documents. The XLeitstelle recommends full vector only for new plans, and few attributes are mandatory ([Bavarian guide](https://digitale.planung.bayern.de/medien/dokumente/leitfaden_xplanung_2_auflage.pdf)). Conformance therefore says nothing about whether rule values are present.
- **Tools**: xPlanBox (manager, validator, WMS/WFS and the version-merging XPlanSyn WFS; AGPL-3.0, OpenCoDE `diplanung/ozgxplanung`); the XLeitstelle's [validator API](https://xleitstelle.xplan.diplanung.de/xplan-validator-api/swagger-ui/index.html) (rules LGPL-2.1, with state profiles); **xmas-core** (XLeitstelle, EUPL-1.2, Python: reads GML and JSON-FG, writes PostGIS, migrates 4.1/5.4/6.0/6.1, the most useful ingest library); QGIS plugins (xmas-plugin, Kreis Viersen's XPlan-Reader). The standard's own licence is *unverified*.

Data by state (2026-10-30):

| State or city | Service | What it holds |
| --- | --- | --- |
| **Hamburg** | `https://hh.xplan.diplanung.de/xplansyn-wfs/services/xplansynwfs` (all versions; per version `…/xplan-wfs/services/wfs41`…`wfs60`), dl-de/by-2.0 | 3,049 plans (all adopted plans), 23,156 area-type zones, 45,259 buildable areas; in 6.0 also 14,729 building limits, 2,775 building lines, 2,741 height points. Zone samples: storeys 53–58 %, GRZ 39–43 %, GFZ 7–24 %. Heights are separate points with an absolute reference and no eaves/ridge reference. The older `geodienste.hamburg.de/HH_WFS_xplan_dls` is stale (3 plans). |
| **Freiburg** (BW) | `https://xplanung.freiburg.de/xplan-services-wfs/services/wfs60` (also 5.4, 5.1, XPlanSyn), dl-de/by-2.0 | 544 plans in 6.0; zone sample GRZ 67 %, GFZ 51 %, storeys 27 %; 26 height points. Other BW cities not checked. |
| **Bavaria** | `https://by.xplan.diplanung.de/xplansyn-wfs/services/xplansynwfs`, licence not stated | 24,928 plans but only 348 zones, in 53 plans: about 99.8 % outline and scan. The state portal moves to DiPlanPortal on 2026-10-31. |
| **Berlin** | `https://gdi.berlin.de/services/wfs/bplan`, dl-de/zero-2.0 | 2,852 plan outlines with a PDF link; not XPlanung. Its DiPlan system is planned for early 2027. |
| **NRW** | bauleitplanung.nrw (about 166 municipal services) | Outlines; displaying XPlanGML is a planned later stage. Cologne plans to publish XPlanung. |
| **Saxony, Hesse** | — | No structured rule service found. |
| Other DiPlanung tenants | XPlanSyn | Brandenburg 25 plans, Lower Saxony 1, others none. |

INSPIRE planned land use derived from XPlanung loses heights with two reference points and other content ([mapping paper](https://www.geodaten.niedersachsen.de/download/85278/Von_XPlanGML_zu_INSPIRE_Bodennutzung_Quelle_avn_.pdf)); it is not a substitute feed.

### Automatic checking and envelopes

- **No production system checks a design against a B-Plan.** XBau and the "Digitaler Bauantrag" exchange permit applications; they do not check rules. A 2026 Bundestag question records the government's 2023 statement that no system can produce a BIM-based application ([Drucksache 21/6854](https://dserver.bundestag.de/btd/21/068/2106854.pdf)).
- **Research**: the BIM-based building permit project (Ruhr-Uni Bochum with Hamburg and NRW, 2018–2020) checked planning-law parameters on a HafenCity plot from Hamburg's XPlanung data, using IFC, mvdXML and BCF ([summary](https://www.inf.bi.ruhr-uni-bochum.de/iib/forschung/projekte/bauantrag.html.en)); which rules is *unverified*. ACCORD's German demonstrator (Tegel, with the XLeitstelle and Fraunhofer IBP) ended 2025. [3D-Lageplan](https://asg.ed.tum.de/en/gis/projects/3d-lageplan) (TUM, RWTH, the XLeitstelle and Cologne, 2024–2026) aims at automatic checks including setbacks; no results yet. A KIT paper (2010) proposed a CityGML extension for permit checking.
- **Envelopes**: the XLeitstelle's "XPlanung 3D" concept (2020) derives CityGML volumes from buildable areas, storeys or heights and mean terrain; no product found. TUM (2024) maps XPlanung to CityGML without generating envelopes. Commercial: syte claims machine-readable B-Plans for 25 % of Germany's area and sells development potential (reads GRZ, GFZ, eaves and ridge heights, building lines); popularc claims maximum-development models; neither documents its method.

### What can be computed

**Plot inside a qualified B-Plan**:

| Kind | Rules |
| --- | --- |
| Generative | Buildable area from building limits, lines and depth, with the building-form side rules; height from eaves, ridge or total height and the plan's reference, or storeys × a storey height from the state definition; state setbacks (0.4 H and its roof rule) or building on the boundary where the plan allows it; footprint from GRZ (and GRZ II), floor area from GFZ, volume from BMZ, all counted under the plan's BauNVO version; uses from the area type and the plan's § 1 restrictions. |
| Check-only | Parking, roof form and pitch, placement of ancillary buildings, fire class, access, noise conditions; text rules in `XP_TextAbschnitt` until read. |
| Discretionary | Exceptions, exemptions, "minor" overshoots (§ 19(4), § 23), consideration of neighbours (§ 15), plans in preparation (§ 33), the housing deviations of § 246e. |

**§ 34 plot**: an honest app can show an *indicative context envelope*: the from–to range of the surrounding block's footprints, storeys, heights, building depth and fronts (outliers marked), the area type when the surroundings match one, and the state setbacks as a hard line, labelled as case-by-case. The project already has the buildings for this in the German cities it draws in 3D.

**An XPlanung adapter is feasible today for Hamburg** (all plans, open licence, already in the 3D coverage) **and Freiburg**, read from the XPlanSyn WFS or with xmas-core. It should draw an envelope only where a zone has storeys or a height, a GRZ and a buildable area, and say why elsewhere. Its open problems: storeys to metres by assumption where heights are absent, absolute heights needing terrain, rules left in text, polygonising building-limit lines, merging amendments, reading under the right BauNVO and state definitions, and Hamburg's Baustufenpläne. Elsewhere in Germany the rules are in scanned plans and PDFs, which would need text and map extraction or a commercial source.

## Croatia in depth

Checked **2026-10-30**, from [NN 152/2023](https://narodne-novine.nn.hr/clanci/sluzbeni/2023_12_152_2228.html) (rulebook on spatial plans), [NN 155/2025](https://narodne-novine.nn.hr/clanci/sluzbeni/2025_12_155_2315.html) (spatial planning act), [NN 115/2015](https://narodne-novine.nn.hr/clanci/sluzbeni/2015_10_115_2191.html) (ISPU regulation), ministry presentations and live service queries.

### ISPU and ePlanovi

- ISPU (Informacijski sustav prostornog uređenja) is run by the ministry (MPGI); its Zavod za prostorni razvoj, the county planning institutes and Zagreb's institute keep the plan registers. Modules include the geoportal, eKatalog (plan register, since 2014), **ePlanovi** (the plan procedure: phases, publication, decisions, archive), the **ePlanovi Editor** (a free web-GIS tool for licensed plan-makers with topology checks and the standard codes and symbols), eDozvola (permits, since 2014), eKonferencija, eNekretnine and others.
- The Editor was piloted on Primorje-Gorski Kotar county, Crikvenica and two local plans (2022) and has been in use since 2024-01-01. ISPU was built with EU funds (2015–2022, HRK 132 million); the recovery plan (NPOO) funds municipalities to make or transform plans (EUR 17 million by April 2025, at most EUR 30,000 each, target 570 plans). The developer is not public (*unverified*).

### The law: every plan is remade in ePlanovi

- **Since 2026-01-01** (NN 155/2025): plans are made and adopted in ePlanovi and the Editor (Art. 83), and the whole procedure runs there. A plan made before 2026 can no longer be amended except as a new-generation plan (Art. 238).
- **All pre-2026 plans lose validity seven years on, around 2033-01-01** (Art. 236, 238), unless their procedure already ran in ePlanovi.
- The rulebook (NN 152/2023, in force 2024-01-01) requires the Editor or a tool whose output passes the Editor's topology rules (Art. 48), and also governs transforming old plans into the new form (Art. 2).
- An electronic location information (*lokacijska informacija*) is generated from ISPU where a new-generation plan exists; elsewhere the municipality issues it by hand (Art. 37).
- The Croatian Chamber of Architects (2023) criticised the rulebook as untested, said "new generation" amounts to digitising old plans, and doubted the 570-plan target; in 2025 architects and urbanists asked for the act to be postponed (*unverified*). The NPOO call's deadlines have been extended into 2026–2027, and about 100 contracts were extended by 2026-05: delays are widespread. No count of finished new-generation plans was found.

### Data model

- The rulebook's annexes are built into the software (Art. 3): a theme catalogue (codes such as `KN-1-1-2001` residential S1, with the plan types and scales each applies to and its styling), the land-use content, relation tables (which uses may combine) and the map sheets. Layer families: `KN-1-1` primary use (up to three per area), `KN-1-2` secondary use, `KN-3-1` areas of implementation rules, `IS-*` infrastructure, `ZP-*` protection. The annexes are published as images only.
- The act leaves the layer structure, validation rules and "electronic standard" to the software (Art. 79(4)). No public schema or code list was found. INSPIRE is not mentioned in the rulebook or the act, and there is no link to XPlanung or another standard; the ISPU regulation names GML or SHP in HTRS96/TM as exchange formats.
- **Rules are text under fixed headings.** Each `KN-3-1` area gets its rules "by entering text in the attribute table" (Art. 7–8), under 15 fixed headings (plot shape and size, siting, coverage `kig`, floor-area ratio `kis`/`kisn`, height and storeys, design, connections …). Coverage, floor-area ratio, facade height `H` and storeys are mandatory (Art. 12–13).
- In a real new-generation Zagreb plan (UPU Trg bana Jelačića, public-hearing draft 2025-11-20) the provisions are generated by the system: the use text from the theme code (M3 = `KN-1-1-5053`), and one article per rule area ("Pravila provedbe za površinu označenu PP-M3") with the 15 headings, each holding free-text points such as coverage 60 % and above-ground floor-area ratio 3.0. Whether the backend also keeps these as numbers is *unverified*.

### Publication

- The geoportal `https://ispu.mgipu.hr` (an Angular app on `/api/v1/`) lists its services as JSON (`gis/catalog-izbornik`, `gis/data?type=izbornik_wms_popis`).
- Plans are published as **raster WMS**: 21 services `https://gis1.mgipu.hr/srv1/PPRasterZ01_Public/wms` … `Z21` (one per county; Z21 is Zagreb with 898 layers: 711 local plans, 58 detailed plans, 17 GUP, 112 city plan) and one for areas of special features. GeoServer, WMS 1.3.0, EPSG:3765/4326, no stated fees or constraints; layer names `HR_ISPU_<type><n>_<code>_R<rev>_<theme>`, e.g. `HR_ISPU_GUP1_01333_R09_KN_1_1`. Some counties serve their own (Brod-Posavina WMTS, Primorje-Gorski Kotar).
- **No vector WFS of plans** was found. National construction areas (2025-09) are available as vectors only by email request and are marked as not for permits. The viewer's per-parcel plan provisions (Info lokacija, with a PDF) need a reCAPTCHA. No explicit open licence; the regulation says downloads are free. A Croatian INSPIRE planned land use dataset was not found.

### Automation

- Announced: plans linked with eDozvola; special and connection conditions issued electronically in eDozvola; BIM models of the preliminary design (IFC, LOD 200) through an hrBIM system from 2027-01-01 for interventions a future rulebook will set ([ministry presentation, 2025-10](https://mpgi.gov.hr/UserDocsImages/slike/press/2025_10_22_Prezentacija_novi%20_zakoni_TG.pdf)).
- Not announced: automatic checking of a design or permit against plan rules, generated building conditions beyond the location information, or 3D plan data. The stated aim since 2021 is an answer to "what may be built here, how, and who issues the conditions".

### Zagreb

- The GUP amendments adopted 2025-09-11 (in force 2025-09-20) were started in 2023, before ePlanovi was required, so they are an old-generation plan and expire around 2033.
- The city's planning institute will make a **new Prostorni plan Grada Zagreba in ePlanovi** (mayor's decision 2026-06-23, SGGZ 24/2026; concept in 2026, "Vizija Zagreb 2050"); new local plans (UPU) are already made there ([2026 work programme](https://www.zzpugz.hr/api/media/file/program-rada-zzpugz-2026.pdf)). No decision on a new-generation GUP was found.

### What this means for the project

- Within about seven years every Croatian plan will exist in one national system with one layer catalogue and the same 15 rule headings per area, which is the shape a single adapter needs. The rule values are text, but text the system generates under fixed headings, so a reader for those headings is far easier than reading free-form plans.
- Today the only open output is raster WMS and per-parcel PDFs behind a reCAPTCHA. The vector rule areas and their attribute text would have to come from the ministry (an open data request), or from the published provisions documents of new-generation plans.
- Zagreb's current GUP source stays as it is until a new-generation GUP exists.

## Slovenia in depth

Checked **2026-10-30**, from the spatial planning act ZUreP-3 ([Uradni list 199/2021](https://www.uradni-list.si/_pdf/2021/Ur/u2021199.pdf)) and its amendments, the [OPIA technical rules v1.3](https://www.gov.si/assets/ministrstva/MNVP/Dokumenti/PIS/Tehnicna_pravila_OPIA_v1-3.pdf), Ljubljana's plan texts and live service queries.

### Who sets what

- ZUreP-3 (applied from 2022-06-01; amendments 3A–3E, the large 3C in force 2025-10-15) with the building act GZ-1. The state adopts national plans (DPN) by decree; regions adopt regional plans; the **municipal council adopts the municipal plan (OPN) and detailed plans (OPPN) by ordinance (odlok)**. Building rules are municipal.
- Under ZUreP-3 the OPN is only an implementing act: land use (namenska raba) and the implementing conditions (PIP: "conditions and solutions for the urban and landscape arrangement … and the architectural design of buildings", Art. 42). Older OPNs such as Ljubljana's still have separate strategic and implementing parts.
- The state's spatial order (Državni prostorski red) gives basic rules, guidance and detailed rules by decree (the only detailed decree found covers photovoltaics). There is no national default envelope where a municipality has none; old pre-OPN plans stay valid until the end of 2027 (ZUreP-3E, final text *unverified*).
- A location information (lokacijska informacija, Art. 279) is issued by the municipality on request, for a fee; it gives the land use, and the implementing conditions only if asked (Art. 326).

### The data standard

- Municipal plans are submitted to the national planning information system (PIS) under the OPIA technical rules: text as PDF, maps as TIFF, and **vector data as Shapefile in D96/TM, 2D**.
- Mandatory OPN layers: plan boundary (`obm_opn`), planning units with land use (`eup_nrp_pos`), and two further layers (`tgd`, `gji_linije`); regulation lines, points and areas (`reg_crte`, `reg_tocke`, `reg_povrsine`) and others only where the plan sets them. Land use is an integer `NRP_ID` from a code list (1011 SS residential, 1021 CU central, 1031 IP industrial, 1052 ZP park …); the planning unit is `EUP_OZN`.
- **Rule columns exist but are optional and typed as text**: floor-area ratio `FI_MIN/MAX`, coverage `FZ_MIN/MAX`, green share `FZP_MIN/MAX`, volume `P`, dwellings `S`, heights `V`, `VN`, `VS`, `VK`, `VP`, `VF`, storeys `E`, roof `STR`, building pattern `VZZ`. There is no open-space factor (FBP) and no setback field.
- Regulation lines are coded: gradbena linija (building line), gradbena meja (building limit), street and courtyard limits, upper-floor limit, basement limit.
- Detailed plans (OPPN) are vector only as their boundary; their rules stay in PDF. No INSPIRE planned land use mapping was found.

### National publication

- **Open WFS 2.0** `https://ipi.eprostor.gov.si/wfs-si-mnvp-pa/wfs` (EPSG:3794; GeoJSON, GML, CSV): planning units `EUP_OPN`, sub-units `PEUP_OPN`, land use with rule columns `NRP_OPN`, regulation lines `REG_CRTE_OPN` and areas `REG_POVRSINE_OPN`, plan boundaries adopted and in preparation. WMS at `…/wms-si-mnvp-pa/wms`. A weekly GeoPackage download exists at [PIS](https://pis.eprostor.gov.si/pis/prenos-podatkov).
- Terms: free use with source, date and authorship cited; the data are informative, the binding text is the Uradni list. Surveying-authority data (parcels, building cadastre, terrain) are [CC BY 4.0](https://e-prostor.gov.si/en/access-to-geodetic-data/).
- Building cadastre WFS `https://ipi.eprostor.gov.si/wfs-si-gurs-kn/wfs`: `STAVBE` (storeys, gross floor area, heights `VISINA_H1/H2/H3` that look like absolute elevations, year built, above- and below-ground outlines), `PARCELE`, `GRADBENE_PARCELE` (building plots; none returned in central Ljubljana). Nationwide lidar 2023–2025 is viewable and downloadable (licence *unverified*).

### Ljubljana: OPN MOL ID

- Adopted 2010, amended 2015, 2018, 2022, 2023 and the 5th amendment in force 2026-08-04; consolidated text on ljubljana.si.
- The rules: coverage, open-space factor, green share and floor-area ratio by land-use subtype (SSce, SScv, SSse, SSsv …) and building type (NA, NB, ND, NV, V, VS, C, F) in a table (Art. 20); heights by type (Art. 21, e.g. NA up to 11.00 m, P+1+attic); setbacks (e.g. 4.00 m from the building-plot boundary). Overrides per planning unit are rows of a PDF table (Annex 1). **The rules apply to the building plot (gradbena parcela), not the cadastral parcel.**
- Ljubljana publishes text and PDFs, and its maps in the UrbInfo viewer, marked informative and unofficial; no open download of its own was found.
- In the national WFS: 7,236 land-use polygons and 7,236 planning units for Ljubljana; 2,488 regulation areas; 631 regulation lines in a central 8 × 8 km box (mostly building limits, some building lines, upper-floor and basement limits). In 300 sampled land-use polygons:
  - 136 had no rule values (roads, farmland).
  - Values are copied from the subtype table, as text: coverage "40", or "stanovanjske stavbe 40, nestanovanjske stavbe 40, kmetijska gospodarstva 70" (per building kind); floor-area ratio "1,2", "/" or "100. člen odloka OPN MOL ID" (a pointer to an article); height "do 11,00 m", "do P+2", "od 9,00 do 14,00 m" or a sentence.
  - The open-space factor and the building type have no column; volume, dwellings, storeys and most height fields were empty. The regulation-line description codes (p, b, a, c) are undocumented.
- 3D: a city 3D viewer (3dportal.ljubljana.si, no download or licence found) and a national pilot 3D view of Ljubljana with extruded building volumes.

### Automation

- **eGraditev**, the digital building-permit service inside PIS, has covered the whole country since 2026-01-05 (Ljubljana among the last). It handles applications, register imports, fees and tracking; no check of a design against plan rules was found. BIM is not mandatory.
- No public or commercial envelope or building-potential tool was found.

### What this means for the project

- **Reading Ljubljana is feasible as a first cut.** One open national WFS gives planning units, land use with rule columns, building lines and limits; the cadastre gives parcels and building heights. The rule values need a parser for Slovenian prose (per building kind, ranges, storeys as "P+2", "/" and article pointers), plus a hand-made table for the open-space factor, setbacks, building types and the Annex 1 overrides. Because the rules apply to building plots that the cadastre does not hold, an envelope on a cadastral parcel is an approximation; detailed-plan areas need their PDFs.
- **The same reader serves every Slovenian municipality** that fills the columns, since the format is national.
- **Writing is well defined**: an OPIA Shapefile pack with numeric rule values, regulation lines from the code list, and the PDF and TIFF parts. Slovenia is the clearest filing target found after XPlanung, because its format is published.

## National Zoning Atlas and Land Use Labs

NZA's current public description says that analysts identify jurisdictions and districts, separately analyse zoning text and maps, repair/digitise map geometry, then review, merge and publish the result. It explicitly says machine learning cannot yet read the nuanced codes to its required accuracy; potential automation is limited to work such as update scraping and GIS drawing/cleaning. [How NZA is made](https://www.zoningatlas.org/how).

The former public *How to Make a Zoning Atlas 2.0* is historical: NZA says its current methodology is maintained internally. It documents the two text/map workflows and their focus on distinct zoning districts. [Methodology record](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4476927). The current LUL dictionaries and API, rather than that historical paper, are the relevant product contract for an integration: [dictionaries](https://www.landuselabs.com/dictionaries) and [API documentation](https://docs.landuselabs.com/api/).

Published regional Atlas distributions are GeoJSON and spreadsheets/CSV, not one uniform executable regulation format. The public NZA data dictionary warns that numeric fields may be strings and are commonly context-dependent, so they cannot generally be converted to one number without an analytical judgement. [Dataset distribution](https://www.mercatus.org/state-and-regional-zoning-atlas-datasets); [2024 data dictionary (PDF)](https://www.mercatus.org/sites/default/files/2024-09/zoning_atlas_data_dictionary_1.pdf).

### Districts, slices and semantic preservation

A **district** is a source-law zoning district with a distinct regulatory regime for use, structures and lots. It can be a base district, overlay, unmapped, or extinct; its native code/name and jurisdiction remain meaningful. Base districts should not overlap, while overlays may overlap them and each other.

A **slice** is derived analytical geography, not an additional legal district. To calculate statistics, NZA flattens overlays: overlapping overlay conflicts retain the more restrictive rule, then the merged overlay overrides conflicting base-district rules. This prevents double-counting and gives an effective polygon for analysis. [NZA slice methodology](https://www.zoningatlas.org/snapshots-methods).

Accordingly, an integration should retain source districts and their rule observations separately from any versioned computed effective slice. A source district must not be rewritten into a flattened output. Permission/procedure values, `overlay`, `not mentioned`, estimated/indeterminate/not-applicable numeric methods, and unmapped/extinct status are distinct evidence states—not booleans, zeroes, or unrestricted permissions. This matches the project’s existing Atlas audit, which records 126 Districts and 185 Slices fields and treats methods as evidence rather than complete law. [Existing audit](planning-rule-audit.md).

An adapter therefore still needs local mappings for use vocabulary, source terminology, textual conditions, formulas, overlay precedence and source effective dates. A sensible future record would retain a characteristic, subject, normalised value and value kind, permission/procedure, source locator, conditions, provenance/review state and time scope. That is a research recommendation, not a new contract.

## Foundations at a glance

| Standard or model | Status and concrete scope | Useful foundation | Limit for a planning app |
| --- | --- | --- | --- |
| **ISO 19152-1 LADM** | International Standard, 2024; legal-spatial kernel. [ISO record](https://www.iso.org/standard/81263.html) | Parties, spatial units, rights/restrictions/responsibilities (RRRs), sources and tenure/provenance identity. | It is a conceptual land-administration kernel, not zoning-rule execution. |
| **ISO 19152-5 LADM Spatial Plan Information** | International Standard, published 2025-08-12. [ISO record](https://www.iso.org/standard/81267.html) | Plan units, blocks/groups, permits, RRRs and plan-source provenance. Strong vocabulary for plan identity and legal lineage. | Conceptual model only; it does not define executable constraint expressions, rule precedence or a universal dimensional-rule catalogue. |
| **INSPIRE Planned Land Use (PLU)** | Binding EU interoperability model: [Regulation 1089/2010, consolidated](https://eur-lex.europa.eu/eli/reg/2010/1089/2023-11-19/eng); [2024 technical guidelines](https://knowledge-base.inspire.ec.europa.eu/publications/inspire-data-specification-land-use-technical-guidelines_en); [PLU XSD](https://inspire.ec.europa.eu/schemas/plu/4.0/PlannedLandUse.xsd). | `SpatialPlan`, `ZoningElement`, `SupplementaryRegulation`, `OfficialDocumentation`, and typed measures/reals/integers/strings; HILUCS and SI references. Good interchange and provenance baseline. | `indicationReference` is provider-defined text. PLU does not standardise FAR, setbacks, overlay precedence, measurement basis or executable evaluation. |
| **APA Land-Based Classification Standards (LBCS)** | APA land-use classification standard. [APA LBCS](https://www.planning.org/lbcs/) | Multi-dimensional activity, function, structure, site-development and ownership classifications; optional mapping vocabulary for use. | Classification only: no districts, legal text, overlays, procedures or constraints. |
| **United States national zoning schema** | No governing nationwide zoning-exchange schema was identified. Washington’s public statewide atlas translates local data but says local publication/organisation is not standardised. [Washington Zoning Atlas](https://www.commerce.wa.gov/growth-management/data-research/waza/) | NZA-style provenance-preserving adapters and comparative attributes. | Atlas mappings do not by themselves establish common executable semantics across local laws. |
| **Germany XPlanung / XPlanGML** | Active German public-sector plan exchange model; 6.1 was released in 2025. [Release](https://xleitstelle.de/node/196); [actual 6.1 XSDs/code lists](https://registry.gdi-de.org/schemas/de.xleitstelle.xplanung/6.1/). | Rich plan types, legal basis, plan-content features, code lists, text/geometry links, versions and conformance validation. | German statutory and code-list semantics. Best as an import/export adapter and design reference, not a country-neutral canonical model. XBau is the related building-application exchange standard, not a zoning-rule model. |
| **Dutch IMRO; STOP/TPOD/IMOP/IMOW** | IMRO is legacy/transitional. Since the 2024 Omgevingswet, STOP/TPOD and its models support official environmental-document publication. [Official overview](https://iplo.nl/digitaal-stelsel/aansluiten/standaarden/stop-tpod-imop/); [specifications/schemas/examples](https://github.com/Geonovum/TPOD). | Publication lifecycle; immutable regulation versions; linked legal text, activity, area designation, norm/value, location and controlled lists. | Strong but Dutch-law-specific. It structures and validates publication/exchange; it is not a generic, complete evaluator. |
| **buildingSMART IFC and IDS** | IFC 4.3 ADD2 is an official global model; [IFC release database](https://technical.buildingsmart.org/standards/ifc/ifc-schema-specifications/). IDS 1.0 became a buildingSMART standard in 2024. [IDS](https://www.buildingsmart.org/standards/bsi-standards/information-delivery-specification-ids/page/4/). | IFC represents a proposed/existing site and building; its constraint resource can associate named hard/soft/advisory metrics. IDS can check IFC delivery requirements. | `IfcZone` is a grouping of project spaces, not municipal zoning geography. IFC/IDS do not encode a jurisdiction’s legal applicability, rule precedence or comprehensive planning-code evaluation. |
| **GeoSPARQL and SHACL** | [GeoSPARQL 1.1](https://www.ogc.org/standards/geosparql/) defines RDF geospatial vocabulary/query; [SHACL](https://www.w3.org/TR/shacl/) validates RDF graphs, including optional SPARQL constraints. | Optional RDF projection: spatial applicability/topology queries and validation of a declared data profile. | Neither provides zoning concepts, legal time, conflict resolution or a regulation language. SHACL validates a model; it does not supply the model’s policy semantics. |
| **CityGML, CityJSON and LandInfra** | Built-environment/land-infrastructure representations. | Geometry, physical assets and visualisation/exchange of existing or proposed form. | Geometry is not legal effect: these models do not turn height, FAR, setback or plan text into operative law. PLATEAU's `urf:` extension is the exception that adds zoning to CityGML. |
| **Finland, Norway, Denmark, Japan, NSW** | National or state plan data with typed rule values ([above](#rule-numbers-as-typed-fields)). | Coded rule types with typed values, drawn buildable areas, per-use limits. | Each bound to its own law and code lists; adapters, not a canonical model. |

## Practical decision record

The present evidence supports considering these foundations if and when a core profile is designed:

- LADM’s source, RRR and plan/permit provenance concepts;
- INSPIRE PLU’s plan, zoning element, supplementary-regulation and official-document separation;
- XPlanung and Dutch STOP/TPOD’s versioned legal text-to-geometry and controlled-value patterns;
- LBCS only as an optional use-classification crosswalk; and
- IFC/IDS and GeoSPARQL/SHACL only as model-exchange or validation integrations for explicitly supported scopes.

It does **not** support adopting any one of them as a complete common zoning schema, nor converting NZA/LUL data into unconditional development entitlement. Before an executable profile is proposed, it needs explicit decisions about the legal/source authority, applicability geometry, effects (permission, requirement, prohibition), conditions/exceptions, overlay conflict policy, units and measurement bases, temporal validity, unsupported states and explainable assessment results. Each source adapter must preserve native fields and citations alongside mapped values.

## Implications for the Permitted layer

Research recommendations, not decisions or implemented contracts.

**One internal rule profile with an adapter per source is supported by the evidence.** No standard can be adopted as that profile (INSPIRE is too thin, the national models are bound to their law, LADM Part 5 is conceptual), but the structured standards share the field set in the [crosswalk](#common-rule-fields-crosswalk), which the Detached rule already mostly covers. The profile should be the project's own, borrowing structure where it fits: INSPIRE's plan, zoning element, supplementary regulation and official documentation; LADM's provenance and three-state permit.

**Map to two layers.** Adapters emit rule observations (each constraint with its unit, measurement basis, condition, source locator and evidence state, where "not mapped" is a valid state) into the shared evaluator (`frontend/js/planning/parcel-assessment.js`); the evaluator derives the envelope, which is all the display needs. An adapter that fills fixed numeric fields for rules it cannot express turns uncertainty into false entitlement. Rules are classed generative, check-only or not computable as in [checking versus deriving](#checking-a-design-versus-deriving-an-envelope); only generative ones reach the envelope.

**One evaluator path.** Today Bogotá and the Atlas sources run the envelope pipeline while Zagreb GUP and the NYC pilot supply per-lot results (a cached solver table, a PLUTO row) ([permitted massing for plan parcels](permitted-plan-parcels.md)). A precomputed result cannot be recombined when a plan changes a plot, nor checked against a design, so every Permitted feature has to be built twice.

**Profile gaps the standards expose**, compared with the Detached rule's constraints:

- a drawn buildable area and building lines, including lines that must be built on;
- required and minimum values (required storeys, minimum floor-area ratio);
- the reference a height is measured to (eaves, ridge, top edge; ground, street or absolute datum);
- limits that differ by use;
- exceptions the plan itself grants.

**Adapters per standard where the data exists, per city where none does.**

| Source | Rule data available | Notes |
| --- | --- | --- |
| NSW EPI layers | Live statewide ArcGIS: FSR, height, lot size, zone | Uses only in plan text. |
| Japan PLATEAU `urf:` / A29 | Per city in PLATEAU; nationwide A29 (coverage, FAR) | A29 v1.0 non-commercial; PLATEAU licence to check per city. |
| Denmark Plandata.dk | Required by law for a plan to take effect | Service fields *unverified*. |
| Netherlands DSO | National APIs; IMRO plans for older plans | Norm types *unverified*. |
| Finland Ryhti | Rolling out 2025–2028 | Open API *unverified*. |
| Germany XPlanung | Hamburg (all about 3,049 plans as vectors) and Freiburg today; elsewhere mostly outline and scan; duty planned from 2027 | One adapter serves every city that publishes vectors; [Germany in depth](#germany-in-depth). |
| Slovenia PIS | Open national WFS of planning units, land use with rule columns (text) and building lines; published Shapefile submission format | Rule text needs parsing and a table for what has no column; rules apply to building plots, not cadastral parcels ([Slovenia in depth](#slovenia-in-depth)). |
| Croatia ePlanovi | Rules required by the rulebook, stored as fixed-heading text per rule area; published as raster WMS only | Every plan must be remade in ePlanovi by about 2033, so one reader of the generated provisions could serve all of Croatia; access to the vectors needs the ministry ([Croatia in depth](#croatia-in-depth)). Zagreb's GUP source is separate today. |
| INSPIRE PLU, France | Use codes reliable; values optional or provider-defined | Useful for uses and rule types, weak for numbers. |
| US, Bogotá, cities without a standard | NZA, Regrid-style schemas, city datasets | Per-city or per-dataset adapters. |

**Uses.** Keep the six building uses and map each source's vocabulary onto them per adapter; CityGML's `function` (intended) and `usage` (actual) match the existing split between a design's use and an observed building's use. Permitted uses under a rule take three states: allowed, conditional and forbidden.

## Open questions

- How often INSPIRE PLU providers fill `dimensioningIndication`.
- The final class and attribute names of ISO 19152-5 (paywalled).
- Whether the Dutch IMOW norm-type list fixes names such as maximum building height.
- Current Plandata.dk service field names; Ryhti's open API and coverage; Norway's open plan endpoints and whether maximum height is structured.
- Whether ePlanovi stores coverage, floor-area ratio and height as numeric fields behind the generated text, and whether the ministry will publish its data model or a vector service.
- Where Japan encodes the uses each district permits; Victoria's numeric planning fields; New Zealand's zone list; Esri LGIM's zoning fields.

## Access and an incremental INSPIRE profile

Checked **2026-10-27**. ISO sells the normative text of ISO 19152-5:2025; its listing offers a sample and prices the publication at CHF 159. International standardisation does not itself imply free access or an open redistribution licence. No official free full text was identified in this check. [ISO publication and sample](https://www.iso.org/standard/81267.html?browse=tc).

INSPIRE's current Land Use technical guidance is freely available under CC BY 4.0. Its feature catalogue separates plans, zoning elements, supplementary regulations and official documentation; it also distinguishes real-world validity from data-version lifespan. [Published technical guidance and licence](https://github.com/INSPIRE-MIF/technical-guidelines/blob/main/data/lu/dataspecification_lu.adoc).

The following are application recommendations, not implemented contracts or a claim of INSPIRE conformance:

| Part to borrow | Benefit for this app | Existing starting point |
| --- | --- | --- |
| `SpatialPlan` identity and membership | Group zones under the plan and edition that introduced them. | Provider/record identity, edition and pinned source revision already exist. |
| `ZoningElement` and `SupplementaryRegulation` relationships | Retain base geography and additional restrictions separately, so an inspector can explain which records affect a parcel. | Atlas district identity and overlay evidence already remain available. Conflict evaluation still needs a local rule. |
| `OfficialDocumentation` | Link a displayed constraint to its source instrument, text or map. | Source URLs exist; precise article/page locators would add value when the source supplies them. |
| Validity and version lifespan | Answer which plan applied on a date and distinguish a legal change from a refreshed download. | Effective-date fields currently remain null, and source projections are latest-only. Populate real dates before adding historical queries. |

Start with one actual European source and a small adapter into the current records. Preserve its native identifiers and terms, then add only the relationships needed to inspect that source. Full GML storage, comprehensive HILUCS remapping and conformance infrastructure have no immediate consumer here. The reusable benefit is source interpretation and traceability; dimensional parsing, frontage, corner-lot treatment and geometry evaluation remain separate, incremental solver work.

