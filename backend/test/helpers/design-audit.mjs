// design-audit.mjs — the measurements behind the design-language ratchets (docs/design-language.md):
// colour / z-index / !important literals per stylesheet, selectors two co-loaded files define with
// conflicting values, breakpoint spellings, `#id` inside `:is()` lists, Title Case and duplicate
// strings in en.json, and English literals written straight into UI sinks. Pure functions over text,
// plus a baseline file the tests compare against so each number may only go down.
//
//   node backend/test/helpers/design-audit.mjs            # print the current numbers
//   node backend/test/helpers/design-audit.mjs --write    # lower the baseline to the current numbers
//
// The baseline (backend/test/fixtures/design-baselines.json) is a ratchet, not a target: after
// reducing literals in a file, rerun with --write so the next regression is caught at the new level.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const FRONTEND = path.join(REPO_ROOT, 'frontend');
export const BASELINE_PATH = path.join(HERE, '..', 'fixtures', 'design-baselines.json');

// ---------- CSS ----------

/** Comment-free CSS, keeping string contents intact. */
export function stripCssComments(css) {
    let out = '';
    let inComment = false;
    let inString = null;
    for (let i = 0; i < css.length; i++) {
        const c = css[i], n = css[i + 1];
        if (inComment) {
            if (c === '*' && n === '/') { inComment = false; i++; }
            continue;
        }
        if (inString) {
            out += c;
            if (c === '\\') { out += n || ''; i++; continue; }
            if (c === inString) inString = null;
            continue;
        }
        if (c === '/' && n === '*') { inComment = true; i++; continue; }
        if (c === '"' || c === "'") inString = c;
        out += c;
    }
    return out;
}

/**
 * A small rule parser: returns [{ media, selector, declarations: { prop: value } }] for every style
 * rule, with the enclosing @media (or other block at-rule) condition as `media` ('' at top level).
 * @keyframes and @font-face bodies are skipped. Good enough to compare two files' declarations.
 */
export function parseCssRules(cssText) {
    const css = stripCssComments(cssText);
    const rules = [];
    const stack = [];
    let i = 0;
    let buf = '';
    while (i < css.length) {
        const c = css[i];
        if (c === '{') {
            const prelude = buf.trim();
            buf = '';
            if (/^@(media|supports|container|layer)\b/.test(prelude)) {
                stack.push({ kind: 'media', condition: prelude.replace(/^@\w+\s*/, '').trim() });
                i++;
                continue;
            }
            if (/^@/.test(prelude)) {
                // @keyframes, @font-face, @page …: skip the whole block
                let depth = 1;
                i++;
                while (i < css.length && depth > 0) {
                    if (css[i] === '{') depth++;
                    else if (css[i] === '}') depth--;
                    i++;
                }
                continue;
            }
            // a style rule: read declarations up to the matching }
            let j = i + 1;
            let depth = 1;
            let body = '';
            while (j < css.length) {
                if (css[j] === '{') depth++;
                else if (css[j] === '}') { depth--; if (depth === 0) break; }
                body += css[j];
                j++;
            }
            const declarations = {};
            body.split(';').forEach(part => {
                const idx = part.indexOf(':');
                if (idx < 0) return;
                const prop = part.slice(0, idx).trim();
                const value = part.slice(idx + 1).trim();
                if (prop) declarations[prop] = value;
            });
            const media = stack.map(s => s.condition).join(' and ');
            prelude.split(',').map(s => s.trim()).filter(Boolean).forEach(selector => {
                rules.push({ media, selector: selector.replace(/\s+/g, ' '), declarations });
            });
            i = j + 1;
            continue;
        }
        if (c === '}') {
            buf = '';
            stack.pop();
            i++;
            continue;
        }
        buf += c;
        i++;
    }
    return rules;
}

const COLOUR_RE = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b|\b(?:rgba?|hsla?)\(/gi;

/** Colour literals (hex, rgb/rgba, hsl/hsla) outside comments. `var(--x)` references are not literals. */
export function countColourLiterals(cssText) {
    const css = stripCssComments(cssText);
    const m = css.match(COLOUR_RE);
    return m ? m.length : 0;
}

export function countZIndexLiterals(cssText) {
    const css = stripCssComments(cssText);
    const m = css.match(/z-index\s*:\s*-?\d+/gi);
    return m ? m.length : 0;
}

export function countImportant(cssText) {
    const css = stripCssComments(cssText);
    const m = css.match(/!important/gi);
    return m ? m.length : 0;
}

/** `:is(` lists that contain an `#id`: the whole rule takes ID specificity and nothing can override it. */
export function idsInsideIsLists(cssText) {
    const css = stripCssComments(cssText);
    const hits = [];
    const re = /:is\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(css))) {
        if (/#[A-Za-z_-]/.test(m[1])) hits.push(m[0].replace(/\s+/g, ' ').slice(0, 120));
    }
    return hits;
}

const ALLOWED_EDGE = new Set(['(max-width: 767.98px)', '(min-width: 768px)']);

/** Media conditions that touch the phone/desktop edge but spell it differently. */
export function breakpointViolations(cssText) {
    const css = stripCssComments(cssText);
    const out = [];
    const re = /@media[^{]*/g;
    let m;
    while ((m = re.exec(css))) {
        const conds = m[0].match(/\((?:max|min)-width:\s*[\d.]+px\)/g) || [];
        conds.forEach(cond => {
            const px = parseFloat(cond.match(/[\d.]+/)[0]);
            if (px >= 760 && px <= 775 && !ALLOWED_EDGE.has(cond.replace(/\s+/g, ' '))) out.push(cond);
        });
    }
    return out;
}

/** The stylesheets index.html loads, in order (the only co-loaded set that can conflict). */
export function coLoadedCssFiles(indexHtml) {
    const m = indexHtml.match(/var cssFiles = \[([\s\S]*?)\];/);
    if (!m) throw new Error('index.html: cssFiles list not found');
    return [...m[1].matchAll(/'([^']+\.css)'/g)].map(x => x[1]);
}

/**
 * Selectors two co-loaded files both define (same media, same selector text) with a different value
 * for the same property. Returned as sorted keys "selector @media | fileA > fileB | prop".
 */
export function conflictingSelectors(filesInOrder, readFile) {
    const seen = new Map(); // key(media|selector) -> [{ file, declarations }]
    filesInOrder.forEach(file => {
        parseCssRules(readFile(file)).forEach(rule => {
            const key = rule.media + '|' + rule.selector;
            if (!seen.has(key)) seen.set(key, []);
            seen.get(key).push({ file, declarations: rule.declarations });
        });
    });
    const out = new Set();
    for (const [key, defs] of seen) {
        const byFile = new Map();
        defs.forEach(d => {
            if (!byFile.has(d.file)) byFile.set(d.file, {});
            Object.assign(byFile.get(d.file), d.declarations);
        });
        const files = [...byFile.keys()];
        for (let a = 0; a < files.length; a++) {
            for (let b = a + 1; b < files.length; b++) {
                const da = byFile.get(files[a]), db = byFile.get(files[b]);
                Object.keys(da).forEach(prop => {
                    if (prop in db && da[prop] !== db[prop]) {
                        const [media, selector] = key.split('|');
                        out.add(`${selector}${media ? ' @' + media : ''} | ${files[a]} > ${files[b]} | ${prop}`);
                    }
                });
            }
        }
    }
    return [...out].sort();
}

// ---------- i18n ----------

export function flattenJson(obj, prefix = '', out = {}) {
    Object.entries(obj).forEach(([k, v]) => {
        const key = prefix ? prefix + '.' + k : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flattenJson(v, key, out);
        else out[key] = v;
    });
    return out;
}

const PROTECTED_WORDS = new Set(['OSM', 'DGU', 'GUP', 'GDI', 'NFT', 'AI', '2D', '3D', 'USDC', 'USDT', 'ETH', 'SOL', 'EUR', 'IPFS',
    'URL', 'JSON', 'API', 'ID', 'GPS', 'HR', 'EN', 'ES', 'SR', 'X', 'YES', 'NO', 'OK', 'I', 'A']);

function isCapitalised(word) {
    return /^[A-Z][a-z]/.test(word);
}

/**
 * Short values (≤ 5 words, ≤ 50 chars) where two or more words beyond the first start with a capital
 * and are not protected: the Title Case habit of the legacy surfaces. Proper nouns inside a label are
 * reported too; the baseline absorbs the ones that are legitimate.
 */
const PROPER_NOUN_KEY_PREFIXES = ['city.labels.', 'languages.'];

export function titleCaseLabels(flat) {
    const out = [];
    Object.entries(flat).forEach(([key, value]) => {
        if (typeof value !== 'string') return;
        if (PROPER_NOUN_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) return;
        const words = value.replace(/\{\{[^}]+\}\}/g, '').trim().split(/\s+/).filter(Boolean);
        if (words.length < 2 || words.length > 5 || value.length > 50) return;
        const caps = words.slice(1).filter(w => isCapitalised(w.replace(/[^A-Za-z]/g, '')) && !PROTECTED_WORDS.has(w.replace(/[^A-Za-z0-9]/g, '')));
        if (caps.length >= 1 && isCapitalised(words[0].replace(/[^A-Za-z]/g, ''))) out.push(`${key} = ${value}`);
    });
    return out.sort();
}

export function normaliseValue(value) {
    return String(value).toLowerCase().replace(/\{\{[^}]+\}\}/g, '{}').replace(/[^\p{L}\p{N}{} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Groups of values that are the same words with different capitalisation ("Create Proposal" / "Create proposal"). */
export function caseConflicts(flat) {
    const byNorm = new Map();
    Object.entries(flat).forEach(([key, value]) => {
        if (typeof value !== 'string' || !value.trim()) return;
        const norm = normaliseValue(value);
        if (!byNorm.has(norm)) byNorm.set(norm, new Map());
        const variants = byNorm.get(norm);
        const exact = value.trim();
        if (!variants.has(exact)) variants.set(exact, []);
        variants.get(exact).push(key);
    });
    const out = [];
    for (const [norm, variants] of byNorm) {
        if (variants.size > 1) out.push(`${norm}: ${[...variants.keys()].join(' / ')}`);
    }
    return out.sort();
}

export function threeDotValues(flat) {
    return Object.entries(flat).filter(([, v]) => typeof v === 'string' && v.includes('...')).map(([k]) => k).sort();
}

export function duplicateValueGroups(flat) {
    const byNorm = new Map();
    Object.entries(flat).forEach(([key, value]) => {
        if (typeof value !== 'string' || normaliseValue(value).length < 3) return;
        const norm = normaliseValue(value);
        if (!byNorm.has(norm)) byNorm.set(norm, []);
        byNorm.get(norm).push(key);
    });
    return [...byNorm.values()].filter(keys => keys.length > 1).length;
}

// ---------- hardcoded UI strings in JS ----------

const SINKS = ['updateStatus', 'showEphemeralMessage', 'showFloatingStatus', 'alert', 'confirm', 'showStyledAlert', 'showStyledConfirm'];

/** Calls to a UI sink whose first argument is a plain English literal of three or more words. */
export function hardcodedSinkLiterals(jsText) {
    const out = [];
    const re = new RegExp(`\\b(${SINKS.join('|')})\\(\\s*(['"\`])((?:\\\\.|(?!\\2)[^\\\\])*)\\2`, 'g');
    let m;
    while ((m = re.exec(jsText))) {
        const text = m[3];
        if (text.includes('${')) continue;
        if (text.trim().split(/\s+/).length < 3) continue;
        if (!/[A-Za-z]{3,}/.test(text)) continue;
        out.push(`${m[1]}: ${text.slice(0, 80)}`);
    }
    return out;
}

// ---------- the audit ----------

export function listFiles(dir, ext) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return listFiles(full, ext);
        return entry.isFile() && entry.name.endsWith(ext) ? [full] : [];
    });
}

export function auditNow() {
    const cssDir = path.join(FRONTEND, 'css');
    const css = {};
    listFiles(cssDir, '.css').sort().forEach(file => {
        const rel = path.relative(FRONTEND, file).replace(/\\/g, '/');
        const text = readFileSync(file, 'utf8');
        css[rel] = {
            colourLiterals: rel === 'css/tokens.css' ? 0 : countColourLiterals(text),
            zIndexLiterals: rel === 'css/tokens.css' ? 0 : countZIndexLiterals(text),
            important: countImportant(text)
        };
    });
    const indexHtml = readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
    const coLoaded = coLoadedCssFiles(indexHtml);
    const conflicts = conflictingSelectors(coLoaded, f => readFileSync(path.join(FRONTEND, f), 'utf8'));

    const en = flattenJson(JSON.parse(readFileSync(path.join(FRONTEND, 'i18n', 'en.json'), 'utf8')));
    const i18n = {
        titleCaseLabels: titleCaseLabels(en).length,
        caseConflicts: caseConflicts(en).length,
        threeDots: threeDotValues(en).length,
        duplicateGroups: duplicateValueGroups(en)
    };

    const js = {};
    listFiles(path.join(FRONTEND, 'js'), '.js').sort().forEach(file => {
        const rel = path.relative(FRONTEND, file).replace(/\\/g, '/');
        const n = hardcodedSinkLiterals(readFileSync(file, 'utf8')).length;
        if (n) js[rel] = n;
    });

    return { css, conflicts, i18n, js };
}

export function readBaseline() {
    if (!existsSync(BASELINE_PATH)) return null;
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const now = auditNow();
    if (process.argv.includes('--write')) {
        writeFileSync(BASELINE_PATH, JSON.stringify(now, null, 2) + '\n');
        console.log(`[${new Date().toISOString()}] wrote ${BASELINE_PATH}`);
    }
    const totals = Object.values(now.css).reduce((a, c) => ({
        colourLiterals: a.colourLiterals + c.colourLiterals, zIndexLiterals: a.zIndexLiterals + c.zIndexLiterals, important: a.important + c.important
    }), { colourLiterals: 0, zIndexLiterals: 0, important: 0 });
    console.log(JSON.stringify({ cssTotals: totals, conflicts: now.conflicts.length, i18n: now.i18n, hardcodedSinkLiterals: Object.values(now.js).reduce((a, b) => a + b, 0) }, null, 2));
}
