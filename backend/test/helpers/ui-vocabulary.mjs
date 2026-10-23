// ui-vocabulary.mjs — the measurements behind the control-vocabulary ratchets (docs/design-language.md):
// which classes paint a button, which rules float an overlay, which selectors colour a bare link,
// which selectors key a selected look on a class, and which scripts still call the browser's own
// confirm / alert / prompt. Pure functions over the frontend's text, plus a baseline file the tests
// compare against so every list may only shrink.
//
//   node backend/test/helpers/ui-vocabulary.mjs            # print the current findings
//   node backend/test/helpers/ui-vocabulary.mjs --write    # lower the baseline to the current findings
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRONTEND, listFiles, parseCssRules, coLoadedCssFiles, stripCssComments } from './design-audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = path.join(HERE, '..', 'fixtures', 'ui-vocabulary-baseline.json');

/** The classes that may paint a button, and the component hooks allowed beside them. */
export const CANONICAL_BUTTON_CLASSES = new Set([
    'btn', 'btn-primary', 'btn-success', 'btn-quiet', 'btn-danger', 'btn-sm', 'btn-block', 'btn-icon', 'btn-yes', 'btn-no',
    'close-circle-btn', 'close-circle-btn--lg', 'cb-link', 'cb-link--external', 'cb-link--quiet',
    'cb-tab', 'cb-segmented__option', 'cb-tile', 'cb-option', 'cb-shimmer',
    'map-shell-button', 'map-shell-button--labelled', 'map-utility-button', 'map-mode-tile', 'map-mode-toggle',
    'map-search__chip', 'map-search__icon-button', 'map-search__clear', 'map-search__back',
    'mobile-dock-sheet-handle', 'site-intro-dot', 'cb-lane-option', 'cb-lane-dropdown-toggle', 'corridor-section-lane'
]);

// What counts as "painting" a control: its colours, lines, shape and type. Size and placement
// (width, height, padding, margin, grid) are layout a component class may still set.
const PAINT_PROPS = /^(background|background-color|background-image|border|border-color|border-top|border-right|border-bottom|border-left|border-radius|color|box-shadow|font|font-family|font-size|font-weight|text-transform|letter-spacing|text-decoration|opacity|filter)$/;

/** The stylesheets the app loads, with their parsed rules. */
export function loadedRules() {
    const index = readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
    const files = coLoadedCssFiles(index);
    const rules = [];
    files.forEach(file => {
        parseCssRules(readFileSync(path.join(FRONTEND, file), 'utf8')).forEach(rule => rules.push({ ...rule, file }));
    });
    return { files, rules };
}

/** Classes that any loaded rule paints (a declaration from PAINT_PROPS on a selector naming the class). */
export function paintingClasses(rules) {
    const painted = new Map();
    rules.forEach(rule => {
        const paints = Object.keys(rule.declarations).some(p => PAINT_PROPS.test(p));
        if (!paints) return;
        [...rule.selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].forEach(m => {
            if (!painted.has(m[1])) painted.set(m[1], new Set());
            painted.get(m[1]).add(rule.file);
        });
    });
    return painted;
}

const SOURCE_EXCLUDES = ['vendor', 'node_modules', 'assets'];

/** Every class list written on a <button> (tag, createElement, el/node/h helper) in HTML and JS. */
export function buttonClassLists() {
    const out = [];
    const files = [
        ...listFiles(FRONTEND, '.html').filter(f => !f.includes(path.sep + 'assets' + path.sep)),
        ...listFiles(path.join(FRONTEND, 'js'), '.js').filter(f => !SOURCE_EXCLUDES.some(x => f.includes(path.sep + x + path.sep)))
    ];
    files.forEach(file => {
        const rel = path.relative(FRONTEND, file).replace(/\\/g, '/');
        const src = readFileSync(file, 'utf8');
        [...src.matchAll(/<button\b([^>]*)>/g)].forEach(m => {
            const cm = m[1].match(/class\s*=\s*(?:"([^"]*)"|'([^']*)')/);
            if (cm) out.push({ file: rel, classes: (cm[1] ?? cm[2]).replace(/\$\{[^}]*\}/g, ' ').trim().split(/\s+/).filter(Boolean) });
        });
        if (rel.endsWith('.js')) {
            // createElement('button') followed by a className assignment within the next 400 characters
            [...src.matchAll(/createElement\(['"]button['"]\)[\s\S]{0,400}?className\s*=\s*(['"`])([^'"`]*)\1/g)].forEach(m => {
                out.push({ file: rel, classes: m[2].replace(/\$\{[^}]*\}/g, ' ').trim().split(/\s+/).filter(Boolean) });
            });
            [...src.matchAll(/\b(?:el|node|h)\(\s*['"]button['"]\s*,\s*(['"`])([^'"`]*)\1/g)].forEach(m => {
                out.push({ file: rel, classes: m[2].replace(/\$\{[^}]*\}/g, ' ').trim().split(/\s+/).filter(Boolean) });
            });
        }
    });
    return out;
}

/** Non-canonical classes on buttons that a loaded stylesheet paints: "file: class" strings. */
export function paintingButtonOffenders() {
    const { rules } = loadedRules();
    const painted = paintingClasses(rules);
    const offenders = new Set();
    buttonClassLists().forEach(({ file, classes }) => {
        classes.forEach(cls => {
            if (CANONICAL_BUTTON_CLASSES.has(cls)) return;
            if (painted.has(cls)) offenders.add(`${cls} (${file})`);
        });
    });
    return [...offenders].sort();
}

const OVERLAY_FAMILIES = [/^\.cb-dialog-overlay/, /^\.cb-toast/, /^\.cb-banner-stack/, /^\.world-view/, /^\.world-handoff/, /^\.command-palette-backdrop/, /^\.map-sheet/, /^\.right-dock-panel/, /^\.info-panel/, /^\.cb-multitab-banner/, /^\.explore-banner/, /^#floating-status/, /^\.leaflet/];

/** Rules that float a full-screen layer (position fixed + inset) outside the allowed families. */
export function overlayOffenders() {
    const { rules } = loadedRules();
    const out = new Set();
    rules.forEach(rule => {
        const d = rule.declarations;
        if (d.position !== 'fixed') return;
        const full = d.inset === '0' || (d.top === '0' && d.left === '0' && (d.right === '0' || d.width === '100%' || d.width === '100vw'));
        if (!full) return;
        if (OVERLAY_FAMILIES.some(re => re.test(rule.selector))) return;
        out.add(`${rule.selector} (${rule.file})`);
    });
    return [...out].sort();
}

/** z-index declarations that are not a token. */
export function zIndexLiteralOffenders() {
    const { rules } = loadedRules();
    const out = new Set();
    rules.forEach(rule => {
        const z = rule.declarations['z-index'];
        if (z === undefined) return;
        if (/^var\(--cb-z-/.test(z) || /^calc\(var\(--cb-z-/.test(z) || z === 'auto' || z === 'inherit') return;
        out.add(`${rule.selector}: ${z} (${rule.file})`);
    });
    return [...out].sort();
}

const LINK_FILE_EXCLUDES = ['css/primitives.css', 'css/page-chrome.css', 'css/tokens.css', 'css/hackathon-deck.css', 'css/hackathon-demo.css', 'css/pitch-variants.css'];

/** Selectors that colour a bare <a> (the link look must come from cb-link). */
export function bareLinkColourOffenders() {
    const out = new Set();
    listFiles(path.join(FRONTEND, 'css'), '.css').forEach(file => {
        const rel = path.relative(FRONTEND, file).replace(/\\/g, '/');
        if (LINK_FILE_EXCLUDES.includes(rel)) return;
        parseCssRules(readFileSync(file, 'utf8')).forEach(rule => {
            if (!/(^|[\s>+~])a(:[a-z-]+)*\s*$/.test(rule.selector)) return;
            if (!('color' in rule.declarations)) return;
            out.add(`${rule.selector} (${rel})`);
        });
    });
    return [...out].sort();
}

/** href="#" anchors in HTML and JS (a click that runs script belongs on a button). */
export function hashHrefOffenders() {
    const out = [];
    const files = [
        ...listFiles(FRONTEND, '.html').filter(f => !f.includes(path.sep + 'assets' + path.sep)),
        ...listFiles(path.join(FRONTEND, 'js'), '.js').filter(f => !SOURCE_EXCLUDES.some(x => f.includes(path.sep + x + path.sep)))
    ];
    files.forEach(file => {
        const rel = path.relative(FRONTEND, file).replace(/\\/g, '/');
        const src = readFileSync(file, 'utf8');
        const n = (src.match(/href\s*=\s*["']#["']/g) || []).length + (src.match(/\.href\s*=\s*['"]#['"]/g) || []).length;
        if (n) out.push(`${rel}: ${n}`);
    });
    return out.sort();
}

/** target="_blank" without rel=noopener, in HTML and JS templates. */
export function blankWithoutNoopener() {
    const out = [];
    const files = [
        ...listFiles(FRONTEND, '.html').filter(f => !f.includes(path.sep + 'assets' + path.sep)),
        ...listFiles(path.join(FRONTEND, 'js'), '.js').filter(f => !SOURCE_EXCLUDES.some(x => f.includes(path.sep + x + path.sep))),
        ...listFiles(path.join(FRONTEND, 'i18n'), '.json')
    ];
    files.forEach(file => {
        const rel = path.relative(FRONTEND, file).replace(/\\/g, '/');
        const src = readFileSync(file, 'utf8');
        [...src.matchAll(/<a\b[^>]*target=\\?["']_blank\\?["'][^>]*>/g)].forEach(m => {
            if (!/rel=\\?["'][^"']*noopener/.test(m[0])) out.push(`${rel}: ${m[0].slice(0, 80)}`);
        });
    });
    return out.sort();
}

/** "↗" typed into a translation string (the mark is cb-link--external's). */
export function typedExternalMarks() {
    const out = [];
    listFiles(path.join(FRONTEND, 'i18n'), '.json').forEach(file => {
        const rel = path.relative(FRONTEND, file).replace(/\\/g, '/');
        const n = (readFileSync(file, 'utf8').match(/\u2197/g) || []).length;
        if (n) out.push(`${rel}: ${n}`);
    });
    return out.sort();
}

const CONTROL_TOKEN = /(\.btn\b|-btn\b|-button\b|-tab\b|__option\b|-chip\b|\.tab\b|-tile\b|-option\b)/;
const STATE_CLASS = /\.(active|selected|is-active|is-selected|is-on|active-black-border)\b|--(active|selected|on)\b/;

/** CSS selectors that key a control's selected look on a class instead of an ARIA state. */
export function classSelectedOffenders() {
    const out = new Set();
    listFiles(path.join(FRONTEND, 'css'), '.css').forEach(file => {
        const rel = path.relative(FRONTEND, file).replace(/\\/g, '/');
        parseCssRules(readFileSync(file, 'utf8')).forEach(rule => {
            if (!CONTROL_TOKEN.test(rule.selector) || !STATE_CLASS.test(rule.selector)) return;
            out.add(`${rule.selector} (${rel})`);
        });
    });
    return [...out].sort();
}

/** Scripts that call the browser's confirm / alert / prompt (outside the dialog helper). */
export function nativeDialogCalls() {
    const out = [];
    listFiles(path.join(FRONTEND, 'js'), '.js').forEach(file => {
        const rel = path.relative(FRONTEND, file).replace(/\\/g, '/');
        if (rel === 'js/ui/dialogs.js' || SOURCE_EXCLUDES.some(x => rel.split('/').includes(x))) return;
        const src = readFileSync(file, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const n = (src.match(/(^|[^.\w$])(?:window\.|global\.|globalThis\.)?(?:confirm|alert|prompt)\s*\(/g) || []).length;
        if (n) out.push(`${rel}: ${n}`);
    });
    return out.sort();
}

/** Inline style attributes on buttons and links in HTML and JS templates (looks belong in classes). */
export function inlineStyledControls() {
    const out = [];
    const files = [
        ...listFiles(FRONTEND, '.html').filter(f => !f.includes(path.sep + 'assets' + path.sep)),
        ...listFiles(path.join(FRONTEND, 'js'), '.js').filter(f => !SOURCE_EXCLUDES.some(x => f.includes(path.sep + x + path.sep)))
    ];
    files.forEach(file => {
        const rel = path.relative(FRONTEND, file).replace(/\\/g, '/');
        const src = readFileSync(file, 'utf8');
        const n = (src.match(/<(?:button|a)\b[^>]*\sstyle\s*=/g) || []).length;
        if (n) out.push(`${rel}: ${n}`);
    });
    return out.sort();
}

export function auditNow() {
    return {
        paintingButtonClasses: paintingButtonOffenders(),
        overlays: overlayOffenders(),
        zIndexLiterals: zIndexLiteralOffenders(),
        bareLinkColours: bareLinkColourOffenders(),
        hashHrefs: hashHrefOffenders(),
        blankWithoutNoopener: blankWithoutNoopener(),
        typedExternalMarks: typedExternalMarks(),
        classSelected: classSelectedOffenders(),
        nativeDialogs: nativeDialogCalls(),
        inlineStyledControls: inlineStyledControls()
    };
}

export function readBaseline() {
    return existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const now = auditNow();
    if (process.argv.includes('--write')) {
        writeFileSync(BASELINE_PATH, JSON.stringify(now, null, 2) + '\n');
        console.log('baseline written to', BASELINE_PATH);
    }
    Object.entries(now).forEach(([key, list]) => {
        console.log(`\n## ${key}: ${list.length}`);
        list.slice(0, process.argv.includes('--all') ? Infinity : 40).forEach(item => console.log('  ' + item));
        if (!process.argv.includes('--all') && list.length > 40) console.log(`  … ${list.length - 40} more (--all)`);
    });
}
