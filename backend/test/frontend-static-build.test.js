import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { SAFE_GROUPS, assertScopeIsolated, buildStatic, findScriptArrays } = require('../../frontend/build-static.cjs');
const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');

function makeTempRoot(prefix) {
    return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixtureFrontend(root) {
    mkdirSync(path.join(root, 'js'), { recursive: true });
    writeFileSync(path.join(root, 'build-static.cjs'), '// deployment helper, never publish');
    writeFileSync(path.join(root, 'index.html'), `<!doctype html><script>
function appendBuildToken(path) {
    return path + '?build=fixture';
}
window.writeVersionedLocalScripts(['js/a.js?v=old', 'js/b.js?v=old', 'js/global.js', 'js/current.js']);
</script>`);
    writeFileSync(path.join(root, 'js/a.js'), `(function () { window.trace.push('a'); window.a = 1; })();`);
    writeFileSync(path.join(root, 'js/b.js'), `(function () { window.trace.push('b:' + window.a); window.b = 2; })();`);
    writeFileSync(path.join(root, 'js/global.js'), `function fixtureGlobal() {}\nwindow.trace.push('global');`);
    writeFileSync(path.join(root, 'js/current.js'), `(function () { if (document.currentScript) window.trace.push('current'); })();`);
}

function runScripts(root, scriptPaths) {
    const sandbox = { trace: [] };
    sandbox.window = sandbox;
    sandbox.document = { currentScript: { src: 'fixture' }, write() { throw new Error('document.write should not be used'); } };
    vm.createContext(sandbox);
    for (const scriptPath of scriptPaths) {
        vm.runInContext(readFileSync(path.join(root, scriptPath.split('?')[0]), 'utf8'), sandbox, { filename: scriptPath });
    }
    return sandbox;
}

describe('production static frontend build', () => {
    it('preserves IIFE order and global semantics while leaving excluded scripts separate', () => {
        const temp = makeTempRoot('cb-static-build-');
        const source = path.join(temp, 'source');
        const output = path.join(temp, 'stage');
        mkdirSync(source);
        mkdirSync(output);
        fixtureFrontend(source);
        const originalIndex = readFileSync(path.join(source, 'index.html'), 'utf8');
        const groups = [{ name: 'fixture', paths: ['js/a.js?v=new', 'js/b.js?v=new'] }];

        const originalPaths = findScriptArrays(originalIndex).flatMap(array => array.items.map(item => item.value));
        const baseline = runScripts(source, originalPaths);
        const result = buildStatic(source, output, groups);
        const stagedIndex = readFileSync(path.join(output, 'index.html'), 'utf8');
        const stagedPaths = findScriptArrays(stagedIndex).flatMap(array => array.items.map(item => item.value));
        const staged = runScripts(output, stagedPaths);

        expect(result).toMatchObject({ beforeCount: 4, afterCount: 3, reduction: 1 });
        expect(stagedPaths).toHaveLength(3);
        expect(stagedPaths[0]).toMatch(/^js\/bundles\/fixture\.[a-f0-9]{16}\.js$/);
        expect(stagedIndex).toContain('if (/^js\\/bundles\\/[^/]+\\.[a-f0-9]{16}\\.js$/.test(path)) return path;');
        const appendTokenBody = stagedIndex.match(/function appendBuildToken\(path\) \{[\s\S]*?\n\s*\}/)?.[0];
        const cacheProbe = {};
        vm.runInNewContext(`${appendTokenBody}; window.bundleToken = appendBuildToken('${stagedPaths[0]}'); window.normalToken = appendBuildToken('js/global.js');`, { window: cacheProbe, encodeURIComponent });
        expect(cacheProbe.bundleToken).toBe(stagedPaths[0]);
        expect(cacheProbe.normalToken).toBe('js/global.js?build=fixture');
        expect(stagedPaths.slice(1)).toEqual(['js/global.js', 'js/current.js']);
        expect(staged.trace).toEqual(baseline.trace);
        expect(staged.fixtureGlobal).toBeTypeOf('function');
        expect(staged.a).toBe(1);
        expect(staged.b).toBe(2);
        expect(readFileSync(path.join(source, 'index.html'), 'utf8')).toBe(originalIndex);
        expect(existsSync(path.join(output, 'build-static.cjs'))).toBe(false);

        const oldBundle = stagedPaths[0];
        writeFileSync(path.join(source, 'js/b.js'), `(function () { window.trace.push('b:' + window.a); window.b = 2; window.trace.push('changed'); })();`);
        buildStatic(source, output, groups);
        const rebuiltPaths = findScriptArrays(readFileSync(path.join(output, 'index.html'), 'utf8'))
            .flatMap(array => array.items.map(item => item.value));
        expect(rebuiltPaths[0]).not.toBe(oldBundle);
        expect(readdirSync(path.join(output, 'js/bundles'))).toHaveLength(1);
        expect(runScripts(output, rebuiltPaths).trace).toEqual(['a', 'b:1', 'changed', 'global', 'current']);
        rmSync(temp, { recursive: true, force: true });
    });

    it('rejects non-IIFE globals, build metadata, and document.write/currentScript scripts', () => {
        expect(() => assertScopeIsolated('js/global.js', 'function topLevel() {}', 'global.js'))
            .toThrow(/parenthesized IIFE/);
        expect(() => assertScopeIsolated('js/injected.js', `(function () {})();\nconst injected = true;\n(function () {})();`, 'injected.js'))
            .toThrow(/one parenthesized IIFE\/UMD expression/);
        expect(() => assertScopeIsolated('js/build-info.js', '(function () {})();', 'build-info.js'))
            .toThrow(/excluded bootstrap/);
        expect(() => assertScopeIsolated('js/writer.js', `(function () { document.write('x'); })();`, 'writer.js'))
            .toThrow(/document\.currentScript\/document\.write/);
        expect(() => assertScopeIsolated('js/current.js', `(function () { return document.currentScript; })();`, 'current.js'))
            .toThrow(/document\.currentScript\/document\.write/);
    });

    it('refuses to replace an unowned non-empty output directory and preserves its contents', () => {
        const temp = makeTempRoot('cb-static-unowned-');
        const source = path.join(temp, 'source');
        const output = path.join(temp, 'stage');
        mkdirSync(source);
        mkdirSync(output);
        fixtureFrontend(source);
        const sentinel = path.join(output, 'keep.txt');
        writeFileSync(sentinel, 'leave this directory alone');

        expect(() => buildStatic(source, output, [{ name: 'fixture', paths: ['js/a.js', 'js/b.js'] }]))
            .toThrow(/Refusing to replace a non-empty output directory/);
        expect(readFileSync(sentinel, 'utf8')).toBe('leave this directory alone');
        rmSync(temp, { recursive: true, force: true });
    });

    it('every safe group is one consecutive script run in the real index.html (the server build refuses otherwise)', () => {
        const index = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
        const arrays = findScriptArrays(index);
        for (const group of SAFE_GROUPS) {
            let found = 0;
            for (const array of arrays) {
                const items = array.items;
                for (let i = 0; i <= items.length - group.paths.length; i += 1) {
                    if (group.paths.every((pathEntry, offset) => items[i + offset].value.split('?')[0] === pathEntry.split('?')[0])) found += 1;
                }
            }
            expect(found, `${group.name}: a script inserted inside the group, or a group member moved, breaks the run`).toBe(1);
        }
    });

    it('keeps the production allowlist scope-isolated and deploys only the staged tree', () => {
        for (const group of SAFE_GROUPS) {
            for (const entry of group.paths) {
                const file = path.resolve(new URL('../../frontend', import.meta.url).pathname, entry.split('?')[0]);
                const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'script' });
                expect(ast.program.body, `${entry} must stay a single isolated classic-script expression`).toHaveLength(1);
                expect(['FunctionDeclaration', 'ClassDeclaration', 'VariableDeclaration'])
                    .not.toContain(ast.program.body[0].type);
            }
        }

        const deploy = read('../../frontend/deploy-frontend.sh');
        const stampAt = deploy.indexOf('Cache-bust token');
        const buildAt = deploy.indexOf('node "$REMOTE_REPO/frontend/build-static.cjs"');
        const syncAt = deploy.indexOf('rsync -a --delete');
        expect(stampAt).toBeGreaterThan(-1);
        expect(buildAt).toBeGreaterThan(stampAt);
        expect(syncAt).toBeGreaterThan(buildAt);
        expect(deploy.slice(syncAt, syncAt + 600)).toContain('"$STAGING_DIR/" "$DOCROOT/"');
    });
});
