// Whether a module is the process's entry point, so a runner can call main() when executed directly
// and stay importable from tests. `import.meta.url === file://argv[1]` was the guard before: under
// PM2's fork container argv[1] is PM2's own container file, so the society and lens-member runners
// loaded, matched nothing and sat idle forever (found on production 2026-10-09). PM2 names the real
// script in pm_exec_path; both candidates are compared as real paths, so symlinks and relative paths
// match too. Pure: argv and env are injected for tests.
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

function realHref(file) {
    try { return pathToFileURL(realpathSync(file)).href; } catch { return null; }
}

export function isEntrypoint(importMetaUrl, { argv = process.argv, env = process.env } = {}) {
    let own;
    try { own = realHref(fileURLToPath(importMetaUrl)); } catch { return false; }
    if (!own) return false;
    return [env.pm_exec_path, argv[1]].filter(Boolean).some(file => realHref(file) === own);
}
