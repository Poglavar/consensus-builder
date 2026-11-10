// silent-catch-audit.mjs — counts the frontend's silent error handlers per file: a `catch {}` block with
// no statement and no comment, and a `.catch(() => {})` callback with an empty body and no comment.
// A swallowed failure looks exactly like success, so the per-file counts may only shrink
// (silent-catch-ratchet.test.js). A handler that must ignore an error says why in a comment.
//
//   node backend/test/helpers/silent-catch-audit.mjs           # print the current counts
//   node backend/test/helpers/silent-catch-audit.mjs --write   # lower the baseline to the current counts
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FRONTEND_JS = path.resolve(HERE, '../../../frontend/js');
export const BASELINE_PATH = path.join(HERE, '..', 'fixtures', 'silent-catch-baseline.json');

function listSources(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'vendor' ? [] : listSources(full);
        return entry.isFile() && /\.(m?js)$/.test(entry.name) ? [full] : [];
    });
}

const hasComment = (node, comments) => comments.some(comment => comment.start >= node.start && comment.end <= node.end);
const emptyBlock = (node, comments) => node && node.type === 'BlockStatement' && node.body.length === 0 && !hasComment(node, comments);

/** The number of silent handlers in one source text. */
export function countSilentCatches(source, sourceType = 'script') {
    const ast = parse(source, { sourceType, errorRecovery: true, allowReturnOutsideFunction: true, plugins: ['jsx'] });
    const comments = ast.comments || [];
    let count = 0;
    const visit = node => {
        if (!node || typeof node.type !== 'string') return;
        if (node.type === 'CatchClause' && emptyBlock(node.body, comments)) count += 1;
        if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression'
            && node.callee.property?.name === 'catch' && node.arguments.length === 1) {
            const handler = node.arguments[0];
            if ((handler.type === 'ArrowFunctionExpression' || handler.type === 'FunctionExpression') && emptyBlock(handler.body, comments)) count += 1;
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
            const value = node[key];
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value.type === 'string') visit(value);
        }
    };
    visit(ast.program);
    return count;
}

/** Per-file counts for frontend/js (vendored libraries excluded), keyed by path relative to it. */
export function currentCounts() {
    const counts = {};
    for (const file of listSources(FRONTEND_JS).sort()) {
        const source = readFileSync(file, 'utf8');
        const count = countSilentCatches(source, file.endsWith('.mjs') || /^\s*(import|export)\s/m.test(source) ? 'module' : 'script');
        if (count) counts[path.relative(FRONTEND_JS, file).split(path.sep).join('/')] = count;
    }
    return counts;
}

export function readBaseline() {
    return existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const now = currentCounts();
    const total = Object.values(now).reduce((sum, n) => sum + n, 0);
    console.log(`${total} silent catch handlers in ${Object.keys(now).length} files`);
    if (process.argv.includes('--write')) {
        const baseline = readBaseline();
        const init = !existsSync(BASELINE_PATH);
        // Only ever lowers: a file above its baseline keeps the baseline (and the test keeps failing).
        const next = Object.fromEntries(Object.entries(now)
            .map(([file, n]) => [file, init ? n : Math.min(n, baseline[file] ?? 0)])
            .filter(([, n]) => n > 0));
        writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n');
        console.log('baseline written to', BASELINE_PATH);
    }
}
