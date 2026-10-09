#!/usr/bin/env node
'use strict';

// Build production-only classic-script bundles from an explicit allowlist of isolated IIFEs/UMD
// wrappers. Source files and the development index are never modified.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SAFE_GROUPS = [
    {
        "name": "foundation",
        "paths": [
            "js/ui/modal-escape.js",
            "js/persistent-storage.js",
            "js/i18n.js",
            "js/format.js",
            "js/multi-tab-guard.js"
        ]
    },
    {
        "name": "environment-before-city",
        "paths": [
            "js/i18n-loader.js",
            "js/version-history.js",
            "js/environment.js",
            "js/wipe-local-data.js",
            "js/world/world-entry-model.js",
            "js/parcel-source-settings.js"
        ]
    },
    {
        "name": "environment-after-city",
        "paths": [
            "js/parcel-source-notice.js",
            "js/ui/world-entry.js",
            "js/city-switch-prompt.js",
            "js/ens/ens-name.js"
        ]
    },
    {
        "name": "chain-clients",
        "paths": [
            "js/wallet-connection.js",
            "js/solana/wallet-adapter.js",
            "js/lens-core.js",
            "js/lens-service-client.js",
            "js/solana/chain-data-loader.js",
            "js/solana/acceptance-client.js",
            "js/solana/acceptance-bridge.js",
            "js/proposals/site-hash.js",
            "js/solana/proposal-bridge.js",
            "js/solana/pledge-client.js",
            "js/solana/pledge-bridge.js",
            "js/solana/market-client.js",
            "js/solana/market-bridge.js",
            "js/solana/parcel-mint.js",
            "js/solana/blockchain-sync.js",
            "js/ipfs.js",
            "js/contracts-loader.js",
            "js/chain-data-loader.js",
            "js/proposal-contracts.js",
            "js/blockchain-sync.js",
            "js/blockchain-proposals.js",
            "js/canton/canton-mode.js",
            "js/canton/canton-counts.js",
            "js/canton/canton-parcel.js",
            "js/canton/canton-explorer.js",
            "js/minted-proposals.js",
            "js/thumbnail-bbox.js",
            "js/guest-policy.js",
            "js/map-screenshot.js",
            "js/og-metadata.js",
            "js/data-source.js",
            "js/basemap.js",
            "js/ui/map-credits.js",
            "js/parcels/utils/fetch-config.js",
            "js/parcels/controller.js",
            "js/parcels/activity-listener.js"
        ]
    },
    {
        "name": "map-ui",
        "paths": [
            "js/urban-blocks-model.js",
            "js/urban-blocks-controller.js",
            "js/urban-blocks-layout.js",
            "js/urban-blocks-links.js",
            "js/urban-blocks-playground.js",
            "js/urban-blocks-view.js",
            "js/ui/commands.js",
            "js/ui/map-shell.js",
            "js/bets/bets-model.js",
            "js/bets/bets-sheet.js",
            "js/mobile-dock-sheet.js",
            "js/ui/simulation-indicator.js",
            "js/ui/parcel-menu-model.js",
            "js/ui/parcel-menu.js",
            "js/ui/ground-menu-model.js",
            "js/ui/ground-menu.js",
            "js/ui/selection-tray.js",
            "js/ui/search-model.js",
            "js/world/world-coverage.js",
            "js/world/globe-math.js",
            "js/world/globe-city-display.js",
            "js/world/activity-model.js",
            "js/world/activity.js",
            "js/world/proposal-entry.js",
            "js/world/arrival.js",
            "js/world/globe.js",
            "js/ui/map-search.js",
            "js/ui/command-palette.js",
            "js/parcels/parcel-id.js",
            "js/parcels/state.js",
            "js/parcels/styles.js",
            "js/parcels/proposals.js",
            "js/parcels/selection.js",
            "js/parcels/ui/info-panel.js",
            "js/parcels/ui/parcel-selection.js",
            "js/parcels/share-format.js",
            "js/parcels/ui/parcel-panel.js",
            "js/parcels/ui/locate.js",
            "js/parcels/ui/road.js",
            "js/parcels/ui/labels.js",
            "js/parcels/ui/owner-counts.js",
            "js/parcels/ui/proposal-counts.js",
            "js/parcels/ui/minted-layer.js",
            "js/parcels/ui/proposal-actions.js",
            "js/parcels/ui/ad-parcels.js",
            "js/parcels/ui/map-refresh.js",
            "js/parcels/ownership.js",
            "js/parcels/ownership-type.js",
            "js/parcels/ownership-highlight.js",
            "js/parcels/utils/geometry.js",
            "js/parcels/parcel-adjacency.js",
            "js/parcels/block-topology.js",
            "js/parcels/corridor-identity.js",
            "js/parcels/live-fabric.js",
            "js/parcels/ingest.js",
            "js/parcels/presenter.js",
            "js/parcels/storage.js",
            "js/parcels/source-health.js",
            "js/parcels/schelling-grid.js",
            "js/parcels/ground-fallback.js",
            "js/parcels/fetch.js",
            "js/parcels/ground-service.js",
            "js/parcels/point-map.js",
            "js/parcels/blocks.js",
            "js/parcels/blockchain.js",
            "js/parcels/ownership-ui.js",
            "js/parcels/ui/visibility.js",
            "js/parcels/ui/claim.js",
            "js/parcels/index.js",
            "js/parcels/route.js",
            "js/proposals/owner-acceptance.js",
            "js/proposals/selection.js"
        ]
    },
    {
        "name": "proposal-geometry",
        "paths": [
            "js/proposals/footprint-parts.js",
            "js/proposals/plan-order.js",
            "js/proposals/site-binding.js",
            "js/proposals/open-ground.js",
            "js/proposals/site-clip.js",
            "js/proposals/site-plots.js",
            "js/proposals/subdivision.js",
            "js/proposals/site-draft.js",
            "js/proposals/publish-binding.js",
            "js/proposals/binding-drift.js",
            "js/proposals/parcel-arrangement.js",
            "js/proposals/readjustment-contributions.js",
            "js/proposals/authored-record.js",
            "js/proposals/formation-depth.js",
            "js/proposals/parcel-contiguity.js",
            "js/proposals/formation-edit.js",
            "js/proposals/corridor-levels.js",
            "js/map-edit-lock.js",
            "js/geometry-edit/history.js",
            "js/geometry-edit/handles.js",
            "js/proposals/plot-topology.js",
            "js/proposals/plot-heal.js",
            "js/proposals/plot-cut.js",
            "js/proposals/drill-stack.js",
            "js/proposals/hover-ground.js",
            "js/proposals/ownership-flow.js",
            "js/proposals/cadastre-ancestry.js",
            "js/proposals/claims.js",
            "js/proposals/dossier.js",
            "js/proposals/claims-ui.js",
            "js/footprint-geometry.js",
            "js/building-ground.js",
            "js/proposal-own-parcel.js"
        ]
    }
];
const EXCLUDED_PATHS = new Set(['js/build-info.js']);
const STAGE_MARKER = '<!-- generated by frontend/build-static.cjs; static build stage v1 -->';

function readString(source, start) {
    const quote = source[start];
    let i = start + 1;
    let value = '';
    while (i < source.length) {
        const ch = source[i++];
        if (ch === quote) return { value, end: i };
        if (ch === '\\') {
            if (i >= source.length) throw new Error('Unterminated escaped script path in index.html');
            const escaped = source[i++];
            const map = { n: '\n', r: '\r', t: '\t' };
            value += Object.prototype.hasOwnProperty.call(map, escaped) ? map[escaped] : escaped;
        } else value += ch;
    }
    throw new Error('Unterminated script path in index.html');
}

function skipSpaceAndComments(source, cursor) {
    let i = cursor;
    while (i < source.length) {
        if (/\s/.test(source[i])) { i += 1; continue; }
        if (source.startsWith('//', i)) {
            const newline = source.indexOf('\n', i + 2);
            i = newline < 0 ? source.length : newline + 1;
            continue;
        }
        if (source.startsWith('/*', i)) {
            const end = source.indexOf('*/', i + 2);
            if (end < 0) throw new Error('Unterminated comment in index.html script list');
            i = end + 2;
            continue;
        }
        break;
    }
    return i;
}

function findScriptArrays(index) {
    const arrays = [];
    const call = /window\.writeVersionedLocalScripts\s*\(/g;
    let match;
    while ((match = call.exec(index))) {
        let cursor = skipSpaceAndComments(index, call.lastIndex);
        if (index[cursor] !== '[') throw new Error('Expected a script path array after writeVersionedLocalScripts(');
        const open = cursor;
        cursor += 1;
        const items = [];
        while (true) {
            cursor = skipSpaceAndComments(index, cursor);
            if (index[cursor] === ']') { cursor += 1; break; }
            if (index[cursor] !== '"' && index[cursor] !== "'") {
                throw new Error('Static build expects string-only writeVersionedLocalScripts arrays');
            }
            const item = readString(index, cursor);
            items.push({ value: item.value, start: cursor, end: item.end });
            cursor = skipSpaceAndComments(index, item.end);
            if (index[cursor] === ',') { cursor += 1; continue; }
            if (index[cursor] === ']') { cursor += 1; break; }
            throw new Error(`Expected comma or ] in writeVersionedLocalScripts array at byte ${cursor}`);
        }
        arrays.push({ start: open, end: cursor, items });
        call.lastIndex = cursor;
    }
    return arrays;
}

function firstCodeIndex(source) {
    let i = source.charCodeAt(0) === 0xFEFF ? 1 : 0;
    while (i < source.length) {
        if (/\s/.test(source[i])) { i += 1; continue; }
        if (source.startsWith('//', i)) {
            const newline = source.indexOf('\n', i + 2);
            i = newline < 0 ? source.length : newline + 1;
            continue;
        }
        if (source.startsWith('/*', i)) {
            const end = source.indexOf('*/', i + 2);
            if (end < 0) break;
            i = end + 2;
            continue;
        }
        break;
    }
    return i;
}


function assertScopeIsolated(pathEntry, source, filename) {
    const file = pathEntry.split('?')[0];
    if (EXCLUDED_PATHS.has(file)) throw new Error(`Refusing to bundle excluded bootstrap script: ${pathEntry}`);
    if (/\bdocument\s*\.\s*(?:currentScript|write)\b/.test(source)) {
        throw new Error(`Refusing to bundle script that depends on document.currentScript/document.write: ${pathEntry}`);
    }
    const first = firstCodeIndex(source);
    const body = source.slice(first).trimEnd().replace(/;+\s*$/, '');
    if (source[first] !== '(' || !body.endsWith(')')) {
        throw new Error(`Allowlisted source must remain one parenthesized IIFE/UMD expression: ${pathEntry}`);
    }
    try {
        // Wrapping the entire trimmed file proves it is a single expression. Checking only its
        // first and last characters would accept an injected declaration between two IIFEs.
        new vm.Script(`(${body}\n)`, { filename });
    } catch (error) {
        throw new Error(`Allowlisted source must remain one parenthesized IIFE/UMD expression: ${pathEntry}`, { cause: error });
    }
}

function bundleSource(group, sourceRoot) {
    const fragments = group.paths.map(pathEntry => {
        const sourceFile = path.resolve(sourceRoot, pathEntry.split('?')[0]);
        if (!sourceFile.startsWith(`${path.resolve(sourceRoot)}${path.sep}`)) {
            throw new Error(`Bundle path escapes frontend source: ${pathEntry}`);
        }
        const source = fs.readFileSync(sourceFile, 'utf8');
        assertScopeIsolated(pathEntry, source, sourceFile);
        return `/* source: ${pathEntry} */\n;\n${source.trim()}\n;`;
    });
    const content = `${fragments.join('\n')}\n`;
    new vm.Script(content, { filename: `bundle:${group.name}` });
    return content;
}

function findGroupOccurrence(arrays, group) {
    const found = [];
    for (const array of arrays) {
        const items = array.items;
        for (let i = 0; i <= items.length - group.paths.length; i += 1) {
            if (group.paths.every((pathEntry, offset) => items[i + offset].value.split('?')[0] === pathEntry.split('?')[0])) {
                found.push({ array, start: items[i].start, end: items[i + group.paths.length - 1].end });
            }
        }
    }
    if (found.length !== 1) {
        throw new Error(`Expected ${group.name} to occur once as a consecutive script run; found ${found.length}`);
    }
    return found[0];
}

function keepHashedBundlesCacheable(index) {
    const signature = 'function appendBuildToken(path) {';
    const first = index.indexOf(signature);
    if (first < 0 || index.indexOf(signature, first + signature.length) >= 0) {
        throw new Error('Expected one appendBuildToken(path) function in index.html');
    }
    const insertion = `${signature}\n                if (/^js\\/bundles\\/[^/]+\\.[a-f0-9]{16}\\.js$/.test(path)) return path;`;
    return index.replace(signature, insertion);
}

function markStageIndex(index) {
    const doctype = /<!doctype\s+html\s*>/i;
    if (doctype.test(index)) return index.replace(doctype, match => `${match}\n${STAGE_MARKER}`);
    return `${STAGE_MARKER}\n${index}`;
}

function countPaths(arrays) { return arrays.reduce((count, array) => count + array.items.length, 0); }

function prepareOutputDirectory(outputDir) {
    if (fs.existsSync(outputDir)) {
        const stat = fs.lstatSync(outputDir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('Static build output must be a real directory');
        }
        const entries = fs.readdirSync(outputDir);
        const isOwnedStage = entries.length > 0
            && entries.includes('index.html')
            && fs.lstatSync(path.join(outputDir, 'index.html')).isFile()
            && fs.readFileSync(path.join(outputDir, 'index.html'), 'utf8').includes(STAGE_MARKER);
        if (entries.length > 0 && !isOwnedStage) {
            throw new Error('Refusing to replace a non-empty output directory without the static-build marker');
        }
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outputDir, { recursive: true });
    // Establish ownership immediately so a partial failed build can safely be retried.
    fs.writeFileSync(path.join(outputDir, 'index.html'), `${STAGE_MARKER}\n`);
}

function buildStatic(sourceRoot, outputDir, groups = SAFE_GROUPS) {
    sourceRoot = path.resolve(sourceRoot);
    outputDir = path.resolve(outputDir);
    if (sourceRoot === outputDir || sourceRoot.startsWith(`${outputDir}${path.sep}`)
        || outputDir.startsWith(`${sourceRoot}${path.sep}`)) {
        throw new Error('Output directory must be separate from the frontend source directory');
    }
    const indexPath = path.join(sourceRoot, 'index.html');
    const originalIndex = fs.readFileSync(indexPath, 'utf8');
    const arrays = findScriptArrays(originalIndex);
    if (!arrays.length) throw new Error('No writeVersionedLocalScripts arrays found in index.html');
    const beforeCount = countPaths(arrays);
    const replacements = [];
    const outputBundles = [];

    for (const group of groups) {
        if (!group.paths || group.paths.length < 2) throw new Error(`Bundle ${group.name} must contain at least two scripts`);
        const occurrence = findGroupOccurrence(arrays, group);
        const content = bundleSource(group, sourceRoot);
        const hash = crypto.createHash('sha256')
            .update(group.name).update('\0').update(group.paths.join('\0')).update('\0').update(content)
            .digest('hex').slice(0, 16);
        const bundlePath = `js/bundles/${group.name}.${hash}.js`;
        replacements.push({ ...occurrence, value: bundlePath });
        outputBundles.push({ path: bundlePath, content });
    }

    let rewrittenIndex = originalIndex;
    replacements.sort((a, b) => b.start - a.start).forEach(replacement => {
        rewrittenIndex = `${rewrittenIndex.slice(0, replacement.start)}'${replacement.value}'${rewrittenIndex.slice(replacement.end)}`;
    });

    rewrittenIndex = markStageIndex(keepHashedBundlesCacheable(rewrittenIndex));

    prepareOutputDirectory(outputDir);
    fs.cpSync(sourceRoot, outputDir, {
        recursive: true,
        filter: source => path.basename(source) !== 'build-static.cjs' && path.resolve(source) !== indexPath
    });
    fs.writeFileSync(path.join(outputDir, 'index.html'), rewrittenIndex);
    const bundleDir = path.join(outputDir, 'js/bundles');
    fs.mkdirSync(bundleDir, { recursive: true });
    for (const bundle of outputBundles) {
        fs.writeFileSync(path.join(outputDir, bundle.path), bundle.content);
    }

    const afterArrays = findScriptArrays(rewrittenIndex);
    const afterCount = countPaths(afterArrays);
    const reduction = beforeCount - afterCount;
    return { beforeCount, afterCount, reduction, bundles: outputBundles.map(item => item.path) };
}

if (require.main === module) {
    const outputDir = process.argv[2];
    const sourceRoot = process.argv[3] || __dirname;
    if (!outputDir) {
        console.error('Usage: node frontend/build-static.cjs <output-directory> [frontend-source-directory]');
        process.exit(2);
    }
    const result = buildStatic(sourceRoot, outputDir);
    console.log(`Static frontend staged at ${path.resolve(outputDir)}`);
    console.log(`Classic script paths: ${result.beforeCount} -> ${result.afterCount} (${result.reduction} requests removed; ${result.bundles.length} bundles)`);
    result.bundles.forEach(bundle => console.log(`  ${bundle}`));
}

module.exports = { SAFE_GROUPS, EXCLUDED_PATHS, findScriptArrays, assertScopeIsolated, buildStatic };
