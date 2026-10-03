# CARTO basemap configuration

Set `CARTO_BASEMAP_API_KEY` in the ignored repository-root `.env`, then generate the browser configuration before serving or publishing:

```sh
python3 scripts/build-carto-config.py --env .env --out frontend/carto-config.js
```

Publish `frontend/carto-config.js` beside its map HTML. The key is required by browser tile requests and is visible to map users; keep it out of Git and restrict allowed websites in the CARTO dashboard. Preserve CARTO and OpenStreetMap attribution.

Server-rendered thumbnails also need `CARTO_BASEMAP_API_KEY` in `backend/.env` (or the running backend environment).
