#!/usr/bin/env node
// Stage a self-contained local npm package from the shared implementation. No npm publication,
// credentials, generated logs or repository state are copied; the package name remains provisional.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = fileURLToPath(new URL('../../', import.meta.url));
export function stageMcpPackage(output) {
    const destination = resolve(output);
    if (existsSync(destination)) throw new Error('Choose a new output directory; existing files are never overwritten');
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const dependencies = {}, seen = new Set(), queue = [resolve(repo, 'backend/agents/mcp-server.mjs'), resolve(repo, 'frontend/js/proposal-manager.js')];
    function visit(file) {
        if (!existsSync(file) || seen.has(file)) return;
        if (!file.startsWith(repo)) throw new Error('Package source escapes the repository');
        seen.add(file);
        const target = resolve(destination, relative(repo, file));
        mkdirSync(dirname(target), { recursive: true }); cpSync(file, target);
        if (!['.js', '.mjs', '.cjs'].includes(extname(file))) return;
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/(?:from\s+|import\s*\(|require\s*\(|new URL\s*\()\s*['"]([^'"]+)['"]/g)) {
            const specifier = match[1];
            if (specifier.startsWith('.')) {
                const path = resolve(dirname(file), specifier);
                if (extname(path)) queue.push(path);
            } else if (!specifier.startsWith('node:')) {
                const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
                if (metadata.dependencies[name]) dependencies[name] = JSON.parse(readFileSync(resolve(repo, 'backend/node_modules', name, 'package.json'), 'utf8')).version;
            }
        }
    }
    // Runtime-loaded browser modules and local cryptographic vendor are part of the shared contract.
    function walk(directory) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const file = resolve(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (['.js', '.json', '.cjs'].includes(extname(file))) queue.push(file);
        }
    }
    walk(resolve(repo, 'frontend/js'));
    walk(resolve(repo, 'frontend/vendor/noble-hashes-1.8.0'));
    queue.push(resolve(repo, 'docs/vocabulary.md'), resolve(repo, 'backend/routes/agent-recipe-schema.json'));
    while (queue.length) visit(queue.shift());
    writeFileSync(resolve(destination, 'backend/package.json'), JSON.stringify({ type: 'module', private: true }, null, 2));
    writeFileSync(resolve(destination, 'package.json'), JSON.stringify({ name: 'urban-game-theory-mcp', version: '0.3.0', private: true,
        description: 'Urban Game Theory MCP: public reads, intent drafts and operator-controlled devnet signing',
        bin: { 'ugt-mcp': 'backend/agents/mcp-server.mjs' }, engines: { node: '>=22' }, dependencies }, null, 2));
    return { directory: destination, files: seen.size, dependencies: Object.keys(dependencies), publication: 'not-published' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const at = process.argv.indexOf('--output');
    if (at < 0 || !process.argv[at + 1]) console.log('Usage: node scripts/mcp-package.mjs --output <new-directory>\nThen npm pack <directory> and run npx --package <tarball> ugt-mcp. Publication is separate.');
    else console.log(JSON.stringify(stageMcpPackage(process.argv[at + 1]), null, 2));
}
