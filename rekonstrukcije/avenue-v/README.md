# Avenue V: public apartment-plan reconstruction

Official sales project: [Eurovilla Avenue V](https://eurovilla.hr/projekt/zagreb-strojarska-vukovarska-avenue-v-ekskuzivan-projekt/651/). Developer: [ViD Park](https://vid-park.com/en/project-en/).

Five distinct published source sheets have been recovered: A-5-2, A-6-2, B-5-2, B-7-3 and B-5-6. One duplicate advertisement reused the A-6-2 image. These sources cover **five of the reported 74 homes**, not complete floors. Common areas, other apartments and basement layouts remain unknown.

`floor-plan-sources.json` records URLs, immutable hashes, the reviewed drawing boundary, scale-bar pixels, room areas, source openings and uncertainties. `unit-models.json` contains metre-scaled wall footprints, slabs, doors, glazing and railings. The reconstruction script verifies hashes and isolates the printed green wall fills. Vertical wall/opening dimensions are explicit estimates; floor elevations printed on the drawings are retained separately.

B-5-6 is internally inconsistent: its heading says B-5-6 / fifth floor, while the drawing says B-3-6 / +11.80. Its floor and elevation are therefore null and its review status remains `needs_review`.

The existing authored Avenue V model provides a project identity and site reference. Its approximate building envelope and the sheet insets do not yet provide a verified global transform for these unit drawings. The unit models are linked to `landmark:avenue-v` in the archive but are not inserted as complete floor plates or used to erase unknown areas of the 3D building.

Regenerate from the original files named in the manifest:

```sh
python3 backend/scripts/reconstruct-avenue-v-floors.py --cache SOURCE_DIRECTORY --qa QA_DIRECTORY --output rekonstrukcije/avenue-v/unit-models.json
PGHOST=localhost node backend/scripts/floor-plan-archive.mjs models --file rekonstrukcije/avenue-v/unit-models.json
```

Source bytes also live in the local database's content-addressed archive. The plan viewer obtains each source by hash, and displays its original listing link.
