<!-- This collection tracks large Pionir/Paron projects reconstructed as app proposals. It is the working index for project discovery, geometry, permits and import/export checks. -->

# Pionir / Paron

This folder collects large Pionir/Paron developments with more than two physical above-ground buildings or volumes. A project can therefore qualify even when its permits call several volumes one *složena građevina*. Each project should ultimately include the site and building footprints as GeoJSON, parcel and permit provenance, dates, and a reproducible proposal-import or construction path.

Site area means the cadastral or documented development-site area, not GBP. `TBD` is intentional: the source proves that the project is large enough for this inventory, but not the missing date, parcel union, or area.

## Defined sites

These projects already have a parcel or permit basis strong enough to start a reconstruction.

| Project | Started / completed | Location and parcel | Site area | Buildings / volumes | Evidence and reconstruction status |
|---|---|---|---:|---:|---|
| [Folnegovićeva–Rapska](https://web.zagreb.hr/Sjednice/2013/Big_Attach_2013.nsf/0/4CDAF8356CA24D72C1257BE40035B06A/%24FILE/palijativna3.pdf) | Main project 2008; use permits 2010–2011 | k.č. 2708/1, k.o. Trnje | 14,198 m² | 3 current DGU polygons | PARON investor. Built geometry can come from DGU, checked against permit plans. |
| [Lovinčićeva F1–F5](https://web.zagreb.hr/Sjednice/2013/Big_Attach_2013.nsf/0/E3D3DCECDA0D6ACEC1257E4D0046B8D7/%24FILE/Paron%20d%20o%20o%20.pdf) | Permit phases from 2013; completion date TBD | k.č. 4091/5, k.o. Peščenica | 15,255 m² | 5 buildings, F1–F5 | PARON investor. Exactly five present-day DGU footprints. |
| [Špansko-Sjever A–F](spansko-sjever-a-f/README.md) | Permit series 2019–2024 | current k.č. 2795/3, k.o. Stenjevec Jug | 23,451 m² | 6 above-ground volumes; legally 2 complex buildings | Reconstructed from the 2022 location-permit geometry and named A–F phase acts; local unapplied proposal and canonical GeoJSON exist. |
| [Lovinčićeva, newer complex](https://www.zagreb.hr/userdocsimages/arhiva/prostorno_uredjenje/GRA%C4%90.Dozvola-19-1939%2CParon%20d.o.o.%20%28D.Leko%29.pdf) | Initial permit 2020; later phased permits from 2022 | k.č. 4090/1, k.o. Peščenica | 31,333 m² | 12 above-ground volumes; legally 5 buildings, plus transformer | PARON investor. Local proposal exists; canonical GeoJSON export is the first round-trip test. |
| [Savica F1–F3](savica-f1-f3/README.md) | Location permit 2018; building permits 2022–2024; built | k.č. 2716/8, k.o. Trnje | 6,667 m² | 3 principal above-ground volumes: F1/F2 residential, F3 office | Current DGU footprints are matched to explicitly labelled permit geometry. A canonical local proposal contains 140 apartments and 8 offices; PARON, TEHNIKAGRADNJA and GIP PIONIR roles remain distinct. |
| [Selska–Drniška](selska-drniska/README.md) | Completed no later than the 2008 GDI survey; exact dates unresolved | k.č. 5652/1, MB 339270, k.o. Trešnjevka | 1,856 m² | 3 mixed-use buildings | Exact three-building site confirmed from Pionir's photographs and current cadastre. Canonical proposal uses deduplicated DGU footprints, GDI heights and Pionir's documented six above-ground storeys; company roles remain unresolved. |
| [Pergošićeva A1–A4](pergosiceva-a1-a4/README.md) | Completed no later than the 2008 GDI survey; exact dates unresolved | k.č. 2859/15, MB 340057, k.o. Stenjevec Jug | 3,236 m² | 4 mixed-use buildings | Exact four-building row confirmed from Pionir's photographs and current cadastre. Proposal preserves 189 apartments, 31 commercial units and 86 garages as site totals; A1–A4 are not assigned to footprints without evidence. |
| [Borongajska–Čavićeva](borongajska-caviceva/README.md) | Location permit 2022; building permits from 2023/2024; ongoing | k.č. 2692/7, k.o. Peščenica | 33,742 m² accepted 2022 permit area; 67,956 m² current parcel/later amendment | 9 above-ground volumes in the accepted 2022 state | Canonical proposal reconstructs all nine compatible 2022 volumes; later final 2025 expansion remains a separate unresolved design state. |
| [Jankomir–Prisavišće P1–P3](https://web.zagreb.hr/Sjednice/sjednice_skupstine_nova.nsf/Dokument_opci_sjednica_noatt_web?OpenForm=&ParentUNID=A04C845176ADA57BC125786F0045BC9F) | Planned 2011; apparently unbuilt | Parts of former k.č. 2316/1, 2316/6 and 2804/1, k.o. Podsused | TBD after historical parcel-union reconstruction | 3 planned buildings | PARON proposal under the UPU. Keep outside built-project statistics. |
| [Zagrebačka avenija–Rudeš](zagrebacka-avenija-rudes/README.md) | Earlier permit 2022–2023; location amendment final Dec 2025; building-permit amendment requested 24 Dec 2025; not built | k.č. 799/1, MB 335614, k.o. Rudeš | 17,980.61 m² | 7 above-ground polygons in the accepted location amendment; later pending polygon may supersede part of them | PARON owns the parcel according to the cited land-register check. The accepted seven-volume state now has a canonical local proposal; the overlapping pending amendment remains a separate source layer. |

Špansko A–F has six physical volumes but only two legal *složene građevine*. Standalone Špansko M/N has only two volumes and K only one, so those do not independently pass the threshold.

### Zagrebačka avenija–Rudeš source note

The parcel is not a newly discovered Pionir interest. In the [2016 GUP public-consultation table](https://www.zagreb.hr/userdocsimages/arhiva/prostorni_planovi/GUP%20ZAGREBA_KP%20lipanj%202016/izvjesca_preth_jr_pjr/ponovna%20javna%20rasprava/03_IZID%20GUP%20GZ_PJR2016_gospodarstvenici%20tablica.pdf), GIP PIONIR submitted a comment for k.č. 799/1, k.o. Rudeš, asking to retain M1 and use rule 2.9/high-rise construction. The City's response said the requested high-building option was already built into the plan, subject to forming a new spatial unit or urban block bounded by public street or park. The 2025–2026 permit trail should be treated as the later project design, not inferred from that 2016 planning comment.

Our 2026 cadastre snapshot resolves the site as parcel id `21362030`, 17,980.61 m². It contains 21 current DGU polygons (mostly economic buildings, plus three houses/structures and small stairs). The GDI 2022 layer contains 25 mostly low footprints. Those are demolition context only, not the proposed residential-commercial geometry. The national public eDozvola WFS identifies the article's exact pending case as `P20251224-1934214-Z11`, class `UP/I-361-03/25-01/002748`; see the [project chronology](zagrebacka-avenija-rudes/README.md).

## Historical portfolio candidates

Pionir's [residential](https://pionir.hr/reference/stambeni-objekti/) and [mixed-use](https://pionir.hr/reference/stambeno-poslovni-objekti/) reference pages identify these as having at least three named buildings or houses. The portfolio pages do not consistently provide construction dates or site areas, so those fields remain unresolved rather than guessed.

| Candidate | Location | Buildings indicated by portfolio | Started / completed | Site area | Next evidence needed |
|---|---|---:|---|---:|---|
| Gračani A1–A6, B1–B4, F | Gračani | 11 labels | TBD | TBD | Parcel identification and DGU grouping |
| Oporovečka A1–A3 | Dubrava | 3 labels | TBD | TBD | Parcel identification and DGU grouping |
| Jarun K1A, K2A–K2F, K3A–K3F | Jarun | 13 labels | TBD | TBD | Parcel identification and construction dates |
| Gornje Prekrižje A–C | Gornje Prekrižje | 3 labels | TBD | TBD | Parcel identification and DGU grouping |
| Bolnička E1–H4 | Vrapče | 16 row-building labels | TBD | TBD | Parcel identification and definition of one project site |
| Dugave, kuće u nizu | Dugave | 13 houses | TBD | TBD | Parcel identification and construction dates |
| Vrbani K4–K6 | Vrbani | 3 named groups/buildings | TBD | TBD | Parcel identification and construction dates |
| Srednjaci A1–A4 | Srednjaci | 4 labels | TBD | TBD | Parcel identification and DGU grouping |
| Špansko D1–D10 | Špansko | 10 labels | TBD | TBD | Distinguish it from the newer northern scheme |
| Remetinečka A–C | Remetinečka cesta | 3 connected lamella labels | built; exact dates TBD | current building parcel 904/1 is only the 1,283 m² footprint | Recover the whole-site parcel union and split the single DGU polygon into A–C volumes from stronger geometry evidence |
| Malešnica KD1–KD6 | Malešnica | 6 labels | TBD | TBD | Parcel identification and DGU grouping |

## On hold or excluded

Mandaličina 10–16, Majstora Radonje 10–16, Malešnica Kaseta D, Utrina, Cvjetno, Bužanova–Rusanova, Horvaćanska/Vrbje, and Vrapče row houses remain on hold: their portfolio names imply complexes, but the current evidence does not yet prove more than two distinct footprints.

Borovje is excluded from this collection because Pionir describes itself as structural contractor for Mešić-com, not the developer. Its UPU reconstruction lives separately in [`rekonstrukcije/upu-borovje`](../upu-borovje/README.md).

## Artifact contract and order

Each project folder should distinguish `observed` DGU/GDI geometry from `planned` permit geometry instead of silently mixing the two. A canonical GeoJSON should retain source ids, observation date, height/floor basis, parcel ids, and whether each value is measured, stated, estimated, or unresolved.

Work order:

1. Export and round-trip the existing newer Lovinčićeva proposal.
2. Reconstruct Folnegovićeva–Rapska and Lovinčićeva F1–F5 from current DGU footprints plus matched GDI heights.
3. Recover permit geometry for Savica F1–F3, Špansko-Sjever, Borongajska–Čavićeva, and Zagrebačka avenija–Rudeš. **Completed as source snapshots and dated canonical proposals for built Savica, Špansko, accepted 2022 Borongaj, and accepted 2025 Rudeš. The expanded 2025 Borongaj state and Rudeš's pending superseding request remain separate because their components cannot yet be combined safely.**
4. Resolve historical candidates one site at a time. **Selska–Drniška and Pergošićeva A1–A4 are complete exact historical portfolio matches; Remetinečka A–C has been located but needs a defensible volume split and whole-site parcel union.**

Official eDozvola source snapshots are refreshed reproducibly with `backend/scripts/fetch-pionir-edozvola-sources.mjs`. They use `consensus-builder.edozvola-source.v1`; these are evidence layers, not app proposals. Canonical proposal exports use `consensus-builder.reconstruction.v1` and must pass an export/import/export identity check.
