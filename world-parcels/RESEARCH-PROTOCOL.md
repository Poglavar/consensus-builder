# Parcel-source research

The durable storage contract changed on 2026-10-19. Research packets, qualification
histories, shared findings and admission archives are retired.

For each WUP city code, keep only these knowledge records:

- `cities/<code>/failed-urls.json`: a deduplicated array of `{ "url": "https://...", "reason": "optional" }` entries describing unsuccessful parcel-source attempts.
- `cities/<code>/settings.json`: explicit app-city bindings, working source URLs and the configuration required by shared adapters.

Settings describe working configuration. A failed URL describes an unsuccessful
attempt; it never establishes that a city has no cadastre. Timeouts, access walls
and empty exact-point reads must not be presented as citywide absence.

Search official municipal, regional and national sources, including the place's
own language and script. Inspect public viewers and their service requests. Use
bounded requests and stable parcel identities, preserve full polygon coordinates,
and omit owner attributes, credentials and private tokens.

Research, independent review, adapter implementation and qualification may use
small temporary packets and request samples. The existing parcel qualification
policy still determines whether a source works. A worker's success label alone
never promotes a source. Only verified working configuration enters settings;
implementation knowledge lives in shared adapter code and focused tests.

After a result is accepted, merge its failed URLs, preserve any successful
settings, and delete the task inputs, outputs, samples, logs, evidence and private
worktree. Native CLI calls run without permanent session transcripts. Active work
may keep temporary recovery files, and a job may keep small queue/progress state.
Do not copy prior histories into task inputs or archive completed workspaces.

`node scripts/lib/parcel-city-settings.mjs --root <repo>` extracts settings from
verified current app configuration. `--apply` rebuilds parcel bindings and source
configuration from settings, preserving unrelated app configuration and labels.
