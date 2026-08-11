// A classic script must not publish a top-level function by wrapping it in a function that calls it
// by name. The name already IS the global, so the wrapper becomes a call to itself.
//
//     function hold(run) { ... }                       // this line already sets window.hold
//     window.hold = (run) => hold(run);                // now `hold` resolves to the wrapper
//     window.hold(fn)  ->  RangeError: Maximum call stack size exceeded
//
// This happened for real: `window.withProposedBuildingsRefreshHeld = run =>
// withProposedBuildingsRefreshHeld(run)` in building-blocks.js took out the first fabric replay of
// every page load, before a single proposal was applied. Nothing caught it — the suite was green,
// because the tests around it read source text and never CALLED the thing.
//
// The safe forms are to publish the function itself (`window.hold = hold`) or, most of the time, to
// publish nothing: a top-level declaration in a classic script is already global.
import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_JS = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../frontend/js');

function listJsFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return listJsFiles(full);
        return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
    });
}

// `window.NAME = ... NAME(...) ...` where NAME is also declared at the top level of the same file.
// Only the program body is walked: a declaration inside an IIFE is module-private, so a wrapper
// around it resolves to the local binding and is perfectly safe.
function selfWrappingAssignments(source) {
    const ast = parse(source, { sourceType: 'script' });
    const topLevel = new Set();
    for (const node of ast.program.body) {
        if (node.type === 'FunctionDeclaration' && node.id) topLevel.add(node.id.name);
    }

    const found = [];
    const walk = (node, assignedName) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(child => walk(child, assignedName)); return; }
        // A bare call to the same name inside the value being assigned to window.NAME.
        if (assignedName && node.type === 'CallExpression'
            && node.callee && node.callee.type === 'Identifier' && node.callee.name === assignedName) {
            found.push({ name: assignedName, line: node.loc ? node.loc.start.line : 0 });
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
            walk(node[key], assignedName);
        }
    };

    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (node.type === 'AssignmentExpression'
            && node.left && node.left.type === 'MemberExpression'
            && node.left.object && node.left.object.type === 'Identifier'
            && (node.left.object.name === 'window' || node.left.object.name === 'globalThis')
            && node.left.property && node.left.property.type === 'Identifier'
            && topLevel.has(node.left.property.name)
            // `window.foo = foo` is fine — it is the function itself, not a wrapper around the name.
            && !(node.right && node.right.type === 'Identifier' && node.right.name === node.left.property.name)) {
            walk(node.right, node.left.property.name);
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
            visit(node[key]);
        }
    };
    visit(ast.program);
    return found;
}

describe('no classic-script global is published as a call to itself', () => {
    const files = listJsFiles(FRONTEND_JS);

    it('has files to check', () => {
        expect(files.length).toBeGreaterThan(50);
    });

    it('finds none', () => {
        const offenders = [];
        for (const file of files) {
            let source;
            try { source = readFileSync(file, 'utf8'); } catch (_) { continue; }
            let hits = [];
            try { hits = selfWrappingAssignments(source); } catch (_) { continue; }
            hits.forEach(hit => offenders.push(`${path.relative(FRONTEND_JS, file)}:${hit.line} — window.${hit.name} calls ${hit.name}`));
        }
        expect(offenders, offenders.join('\n')).toEqual([]);
    });

    it('can go red — the exact shape that broke the replay is detected', () => {
        const broken = `
            function hold(run) { return run(); }
            window.hold = (run) => hold(run);
        `;
        expect(selfWrappingAssignments(broken).map(hit => hit.name)).toEqual(['hold']);
    });

    it('does not flag the safe forms', () => {
        expect(selfWrappingAssignments('function hold(r){return r();} window.hold = hold;')).toEqual([]);
        // Inside an IIFE the name is module-private, so a wrapper resolves to the local binding.
        expect(selfWrappingAssignments(
            '(function(){ function hold(r){return r();} window.hold = (r) => hold(r); })();')).toEqual([]);
        // A wrapper around a DIFFERENT function is not self-reference.
        expect(selfWrappingAssignments(
            'function hold(r){return r();} function other(r){return r;} window.hold = (r) => other(r);')).toEqual([]);
    });
});
