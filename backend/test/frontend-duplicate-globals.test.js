// Guards the frontend's global namespace. The frontend loads plain classic <script> files (see the
// list in frontend/index.html), so a top-level `function foo() {}` creates a GLOBAL binding — and if
// two files both declare `foo`, the last file loaded silently wins for every unqualified caller in
// every file. That is invisible at the call site and has already produced real bugs (three copies of
// escapeHtml disagreed on what to do with null; the share codec had a whole second copy that was
// shadowed and never ran).
//
// This test fails on any function name declared at the TOP LEVEL of more than one file. Functions
// nested inside an IIFE or another function are module-private and are not globals, so they are not
// collected — only `ast.program.body` is walked.
//
// KNOWN_COLLISIONS below is the pre-existing backlog, not a place to park new ones. Adding a name to
// it means "two files disagree about who owns this global"; the fix is to keep one definition and
// delete the rest, not to extend the list.

import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_JS = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../frontend/js');

// Pre-existing duplicates, all centred on proposals/sharing.js re-declaring helpers that other
// proposals/* files already own. sharing.js loads last, so ITS copy is the one that runs everywhere.
// Names marked (DIVERGENT) have bodies that actually differ between the copies — those are latent
// bugs of the same shape as the escapeHtml one, where the version people read is not the version
// that executes. The rest are byte-identical copies that will drift.
const KNOWN_COLLISIONS = new Set([
    'buildBoundsFromSharedPayload',          // (DIVERGENT) sharing.js vs proposals/geometry.js
    'ensureAncestorProposalsUploaded',       // (DIVERGENT) sharing.js vs proposals/server-sync.js
    'ensurePolygonIsClosed',                 // (DIVERGENT) government-plan-worker.js vs road-drawing.js
    'getCurrentUserAgent',                   // (DIVERGENT) agents.js vs user-management.js
    'getParcelDisplayNumberFromProperties',  // (DIVERGENT) sharing.js vs proposals/parcel-id.js
    'getParcelIdFromFeature',                // (DIVERGENT) road-drawing.js vs proposals/parcel-id.js
    'getShareI18nHelper',                    // (DIVERGENT) proposals/core.js vs sharing.js
    'getSharedInspectorI18nHelper',          // (DIVERGENT) proposals/dialog-share.js vs sharing.js
    'headProposalExists',                    // (DIVERGENT) sharing.js vs proposals/server-sync.js
    'normalizeFeature',                      // (DIVERGENT) government-plan-worker.js vs proposals/core.js
    'buildCityQueryParam',                   // sharing.js vs proposals/server-sync.js
    'buildLeafletBoundsFromArray',           // sharing.js vs proposals/geometry.js
    'checkParcelsOriginal',                  // sharing.js vs proposals/storage.js
    'collectCoordinatesFromGeometry',        // sharing.js vs proposals/geometry.js
    'collectParcelProposalPairs',            // sharing.js vs proposals/storage.js
    'computeBoundsFromGeoJSONFeatures',      // sharing.js vs proposals/geometry.js
    'computeSharedBoundingBoxFromFeatures',  // proposals/core.js vs sharing.js
    'getParcelDisplayNumberFromFeature',     // sharing.js vs proposals/parcel-id.js
    'getServerProposalId',                   // sharing.js vs proposals/server-sync.js
    'isProposalCurrentlyApplied',            // sharing.js vs proposals/execution.js
    'mapGoalToBackendType',                  // sharing.js vs proposals/server-sync.js
    'migrateRoadAssetsToNewId',              // sharing.js vs proposals/storage.js
    'resolveBackendBaseUrl',                 // proposals/core.js vs sharing.js
    'resolveFrontendBaseUrl',                // proposals/core.js vs sharing.js
    'sortProposalIdsForShare',               // proposals/core.js vs sharing.js
    'syncProposalWithServerId',              // sharing.js vs proposals/server-sync.js
    'uploadProposalToServer'                 // sharing.js vs proposals/server-sync.js
]);

function listJsFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return listJsFiles(full);
        return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
    });
}

// Collects only the function declarations that become globals: the ones directly in the program
// body. Anything inside an IIFE, block or another function is module-private and is skipped.
function topLevelFunctionNames(source) {
    const ast = parse(source, { sourceType: 'script' });
    return ast.program.body
        .filter(node => node.type === 'FunctionDeclaration' && node.id)
        .map(node => ({ name: node.id.name, line: node.loc.start.line }));
}

describe('frontend global namespace', () => {
    const files = listJsFiles(FRONTEND_JS);

    it('finds the frontend scripts', () => {
        expect(files.length).toBeGreaterThan(100);
    });

    it('declares each top-level (global) function in exactly one file', () => {
        const byName = new Map();

        for (const file of files) {
            const relative = path.relative(FRONTEND_JS, file);
            for (const { name, line } of topLevelFunctionNames(readFileSync(file, 'utf8'))) {
                if (!byName.has(name)) byName.set(name, []);
                byName.get(name).push(`js/${relative}:${line}`);
            }
        }

        const collisions = [...byName.entries()]
            .filter(([name, locations]) => locations.length > 1 && !KNOWN_COLLISIONS.has(name))
            .map(([name, locations]) => `  ${name} declared in ${locations.length} files:\n${locations.map(l => `      ${l}`).join('\n')}`);

        expect(
            collisions,
            `These top-level functions are declared in more than one classic script, so the last file\n`
            + `loaded silently wins for every caller. Keep one definition and delete the rest — do not\n`
            + `add them to KNOWN_COLLISIONS.\n\n${collisions.join('\n')}\n`
        ).toEqual([]);
    });

    it('KNOWN_COLLISIONS has no stale entries — fixed duplicates must be removed from the list', () => {
        const duplicated = new Set();
        const seen = new Map();

        for (const file of files) {
            for (const { name } of topLevelFunctionNames(readFileSync(file, 'utf8'))) {
                if (seen.has(name) && seen.get(name) !== file) duplicated.add(name);
                seen.set(name, file);
            }
        }

        const stale = [...KNOWN_COLLISIONS].filter(name => !duplicated.has(name));
        expect(stale, `No longer duplicated — remove from KNOWN_COLLISIONS: ${stale.join(', ')}`).toEqual([]);
    });
});
