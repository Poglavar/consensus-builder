<!-- Research record: standards are compared as potential semantic foundations, not implementation decisions. -->
# Zoning and spatial-plan standards research

Checked **2026-10-26**. This record compares the National Zoning Atlas/Land Use Labs (NZA/LUL) data products with established spatial-plan, land-use, building-information and linked-data standards. It is research only: it does not select or introduce a new core schema, rule engine, importer, or legal-compliance claim.

## Practical finding

No reviewed standard is a generally applicable, turnkey, machine-executable zoning law model. The useful distinction is between:

1. **Semantic foundations and exchange models** — identity, source authority, plan version, legal text, geographic applicability, controlled values and quantities; and
2. **An application-specific executable profile** — explicit rule effects, conditions, precedence, measurement bases, temporal applicability and an evaluator for the supported subset.

An app can adopt the first without claiming that the second has been solved. Source-specific adapters remain necessary for NZA/LUL, individual jurisdictions, XPlanung, Dutch plans and IFC.

## National Zoning Atlas and Land Use Labs

NZA's current public description says that analysts identify jurisdictions and districts, separately analyse zoning text and maps, repair/digitise map geometry, then review, merge and publish the result. It explicitly says machine learning cannot yet read the nuanced codes to its required accuracy; potential automation is limited to work such as update scraping and GIS drawing/cleaning. [How NZA is made](https://www.zoningatlas.org/how).

The former public *How to Make a Zoning Atlas 2.0* is historical: NZA says its current methodology is maintained internally. It documents the two text/map workflows and their focus on distinct zoning districts. [Methodology record](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4476927). The current LUL dictionaries and API, rather than that historical paper, are the relevant product contract for an integration: [dictionaries](https://www.landuselabs.com/dictionaries) and [API documentation](https://docs.landuselabs.com/api/).

Published regional Atlas distributions are GeoJSON and spreadsheets/CSV, not one uniform executable regulation format. The public NZA data dictionary warns that numeric fields may be strings and are commonly context-dependent, so they cannot generally be converted to one number without an analytical judgement. [Dataset distribution](https://www.mercatus.org/state-and-regional-zoning-atlas-datasets); [2024 data dictionary (PDF)](https://www.mercatus.org/sites/default/files/2024-09/zoning_atlas_data_dictionary_1.pdf).

### Districts, slices and semantic preservation

A **district** is a source-law zoning district with a distinct regulatory regime for use, structures and lots. It can be a base district, overlay, unmapped, or extinct; its native code/name and jurisdiction remain meaningful. Base districts should not overlap, while overlays may overlap them and each other.

A **slice** is derived analytical geography, not an additional legal district. To calculate statistics, NZA flattens overlays: overlapping overlay conflicts retain the more restrictive rule, then the merged overlay overrides conflicting base-district rules. This prevents double-counting and gives an effective polygon for analysis. [NZA slice methodology](https://www.zoningatlas.org/snapshots-methods).

Accordingly, an integration should retain source districts and their rule observations separately from any versioned computed effective slice. A source district must not be rewritten into a flattened output. Permission/procedure values, `overlay`, `not mentioned`, estimated/indeterminate/not-applicable numeric methods, and unmapped/extinct status are distinct evidence states—not booleans, zeroes, or unrestricted permissions. This matches the project’s existing Atlas audit, which records 126 Districts and 185 Slices fields and treats methods as evidence rather than complete law. [Existing audit](planning-rule-audit.md).

An adapter therefore still needs local mappings for use vocabulary, source terminology, textual conditions, formulas, overlay precedence and source effective dates. A sensible future record would retain a characteristic, subject, normalised value and value kind, permission/procedure, source locator, conditions, provenance/review state and time scope. That is a research recommendation, not a new contract.

## Comparison of usable models

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
| **CityGML, CityJSON and LandInfra** | Built-environment/land-infrastructure representations. | Geometry, physical assets and visualisation/exchange of existing or proposed form. | Geometry is not legal effect: these models do not turn height, FAR, setback or plan text into operative law. |

## Practical decision record

The present evidence supports considering these foundations if and when a core profile is designed:

- LADM’s source, RRR and plan/permit provenance concepts;
- INSPIRE PLU’s plan, zoning element, supplementary-regulation and official-document separation;
- XPlanung and Dutch STOP/TPOD’s versioned legal text-to-geometry and controlled-value patterns;
- LBCS only as an optional use-classification crosswalk; and
- IFC/IDS and GeoSPARQL/SHACL only as model-exchange or validation integrations for explicitly supported scopes.

It does **not** support adopting any one of them as a complete common zoning schema, nor converting NZA/LUL data into unconditional development entitlement. Before an executable profile is proposed, it needs explicit decisions about the legal/source authority, applicability geometry, effects (permission, requirement, prohibition), conditions/exceptions, overlay conflict policy, units and measurement bases, temporal validity, unsupported states and explainable assessment results. Each source adapter must preserve native fields and citations alongside mapped values.

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

