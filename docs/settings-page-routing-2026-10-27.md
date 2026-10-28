# Settings page navigation

The preview on port 5698 used a temporary serve configuration containing only cache headers and
the single-page fallback. Its default clean-URL handling redirected sources.html and feedback.html
to extensionless paths. Those paths then received index.html, reopening the map instead of either
destination page. The normal project configuration already disables clean-URL redirects.

The temporary configuration now uses the project routing rules, and the frontend was restarted
on the same port without the blanket single-page fallback. Explicit /sources and /feedback aliases
also resolve to their HTML pages, including URLs already open after the old redirects. All four
paths now return the correct HTML directly and preserve query parameters. The route additions
were included in concurrent commit 7ed6200e9.

The Feedback link now carries the map's resolved backend, matching the Sources link. This keeps
a custom local API port instead of silently reverting to the default API on the destination page.
The existing feedback payload, privacy filtering and submission operation are unchanged.

Two targeted headed Playwright cases passed against the corrected preview: actual Settings link
navigation, HTML and extensionless destinations, source metadata, form rendering and backend
retention. No full suite ran. A manual headed Chrome check loaded 19 real source abstractions from
the selected local API and confirmed that the Feedback form initialized with that same API.
No feedback report was submitted. The dedicated verification browser was closed; the corrected
user preview remains running.

MCP parity: page routing and backend transport context change no editable field, authoring record,
validation rule or source-data contract. Existing source inspection and feedback operations remain
unchanged, so no MCP schema or tool change is required.
