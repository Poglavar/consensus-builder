// Helpers for the frontend bare-script and code-file-ceiling ratchets.
//   node backend/test/helpers/frontend-architecture-ratchets.mjs           # print current counts
//   node backend/test/helpers/frontend-architecture-ratchets.mjs --write   # lower baselines only
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../../..');
export const FRONTEND_ROOT = path.join(REPO_ROOT, 'frontend');
export const BARE_SCRIPTS_BASELINE_PATH = path.join(HERE, '..', 'fixtures', 'bare-scripts-baseline.json');
export const CODE_FILE_CEILINGS_PATH = path.join(HERE, '..', 'fixtures', 'code-file-ceilings.json');

const require = createRequire(import.meta.url);
const { assertScopeIsolated, findScriptArrays } = require(path.join(FRONTEND_ROOT, 'build-static.cjs'));

export function currentBareEagerScripts(frontendRoot = FRONTEND_ROOT) {
    const html = readFileSync(path.join(frontendRoot, 'index.html'), 'utf8');
    const paths = findScriptArrays(html).flatMap(array => array.items.map(item => item.value.split('?')[0]));
    const bare = [];
    for (const entry of paths) {
        const full = path.join(frontendRoot, entry);
        if (!existsSync(full)) continue;
        try {
            assertScopeIsolated(entry, readFileSync(full, 'utf8'), full);
        } catch {
            bare.push(entry);
        }
    }
    return [...new Set(bare)].sort();
}

export function diffBareScripts(current, baseline) {
    const allowed = new Set(baseline);
    const active = new Set(current);
    return {
        added: current.filter(entry => !allowed.has(entry)),
        stale: baseline.filter(entry => !active.has(entry))
    };
}

export function countLines(filePath) {
    return readFileSync(filePath, 'utf8').split('\n').length;
}

export function checkCodeFileCeilings(ceilings, repoRoot = REPO_ROOT) {
    const exceeded = [];
    const missing = [];
    for (const [relativePath, maxLines] of Object.entries(ceilings)) {
        const full = path.join(repoRoot, relativePath);
        if (!existsSync(full)) {
            missing.push(relativePath);
            continue;
        }
        const lines = countLines(full);
        if (lines > maxLines) exceeded.push({ file: relativePath, lines, maxLines });
    }
    return { exceeded, missing };
}

export function readBareScriptsBaseline() {
    return existsSync(BARE_SCRIPTS_BASELINE_PATH)
        ? JSON.parse(readFileSync(BARE_SCRIPTS_BASELINE_PATH, 'utf8'))
        : [];
}

export function readCodeFileCeilings() {
    return existsSync(CODE_FILE_CEILINGS_PATH)
        ? JSON.parse(readFileSync(CODE_FILE_CEILINGS_PATH, 'utf8'))
        : {};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const bareNow = currentBareEagerScripts();
    const ceilings = readCodeFileCeilings();
    console.log(`${bareNow.length} eager scripts fail assertScopeIsolated`);
    if (process.argv.includes('--write')) {
        const baseline = readBareScriptsBaseline();
        const allowed = new Set(baseline);
        const nextBare = existsSync(BARE_SCRIPTS_BASELINE_PATH)
            ? bareNow.filter(entry => allowed.has(entry))
            : bareNow;
        writeFileSync(BARE_SCRIPTS_BASELINE_PATH, JSON.stringify(nextBare, null, 2) + '\n');

        const nextCeilings = {};
        for (const [relativePath, prevMax] of Object.entries(ceilings)) {
            const full = path.join(REPO_ROOT, relativePath);
            if (!existsSync(full)) continue;
            const rounded = Math.ceil(countLines(full) / 100) * 100;
            nextCeilings[relativePath] = Math.min(prevMax, rounded);
        }
        writeFileSync(CODE_FILE_CEILINGS_PATH, JSON.stringify(nextCeilings, null, 2) + '\n');
        console.log('Ratchet baselines lowered where applicable.');
    }
}
