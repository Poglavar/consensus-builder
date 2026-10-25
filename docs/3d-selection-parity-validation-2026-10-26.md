# Shared model and Google 3D selection validation

Google view now supplies surface positions and immutable cadastral geometry to the same click
handler, click stack and inspectors used by model view. Its former independent parcel click
listener and reference/area card are removed. Cadastral boundary drawing remains optional and
does not gate selection. Permitted massing and source inspectors are available in both views.

## Focused automated checks

- Headless unit tests: five explicit files, 93 passed and one unrelated UI-command registration
  failure. The failing assertion also fails with the baseline test and baseline HTML: the
  economic-source settings button has no registered command. An initial baseline probe restored
  only HTML, so it additionally reported the retired parcel-close button against the updated
  allowlist; restoring the baseline test removed that artificial difference.
- Headless unit tests: seven explicit selection, planning, startup and global-guard files,
  79 passed. A final three-file lifecycle/palette run passed 39 checks, including a new regression
  for retained Google tiles after their active scene has been released. These runs overlap.
  Across the focused runs, 125 distinct checks passed and the one baseline failure remained.
- Headless Playwright: four focused cases passed in `photo-and-walk.spec.ts`: parcel selection
  with boundary ink hidden; design selection, hatch, collapse and repeated-click cycling; source
  building inspection across a model-view switch; permitted massing, its inspector and controls.
- Browser-test iterations corrected an ambiguous section/row selector, exact floating-point
  camera equality, and a fixture missing the configured planning-source identity and response
  city. Failed runs used `--max-failures=1`; remaining cases were not run until corrected.
- The initial sandboxed browser invocation could not reach the loopback preview and stopped
  during its web-server readiness check, before running any case. The targeted runs then used
  the permitted local-browser environment. No full unit or browser suite was run.

## Real headed browser check

The original 17-design Digbeth composition loaded through the production read API in a local
headed Chrome. The backend resolved to `https://api.urbangametheory.xyz`; a referenced design
returned HTTP 200. Google tiles reached a grounded, fully loaded view without failed requests.
A trusted click on an applied park opened its Design section with a yellow outline and hatch.
A repeat click advanced to Parcel, retaining the camera. The old picker was absent. The scene
and selected card were visually inspected, and the dedicated verification browser was closed.

Google imagery is a visual mesh: source building identities require a known footprint. Authored
volumes use their drawn outlines; source objects without addressable Google volumes use their
footprint on the loaded surface. Missing height samples leave gaps instead of zero-height lines.
