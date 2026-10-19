// Guards the classic frontend scripts against names that are used but declared nowhere. In a classic
// script such a name only fails when the line runs (a ReferenceError at click time), so no other
// test notices: the activity explorer shipped reading `activityExplorerState`, `activityApiBase` and
// `actorExplorerController`, none of which existed, and every way into it threw.
//
// The check is deliberately coarse. A name counts as declared if ANY binding of that name exists in
// the same file (function, parameter, variable, catch, class, import), if a top-level declaration of
// it exists in any frontend file, if some file assigns it as a property (`window.x =`, `root.x =`,
// `Object.assign(global, { x })` or `Object.assign(global, api)` with `const api = { x }`), or if
// it is a browser/JS built-in or a vendored library global. Only call targets (`foo()`) and member
// objects (`foo.bar`) are checked, and a name the file tests with `typeof` is treated as optional.
// So it misses scoping mistakes, but it cannot miss a name that exists nowhere at all.

import { describe, expect, it } from 'vitest';
import { parse } from '@babel/parser';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const FRONTEND_JS = path.join(ROOT, 'frontend/js');

// Browser globals Node does not have, and the vendored libraries' globals.
const BROWSER_GLOBALS = [
    'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'alert', 'confirm',
    'prompt', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia', 'indexedDB',
    'Image', 'HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'ResizeObserver',
    'IntersectionObserver', 'Worker', 'XMLHttpRequest', 'screen', 'devicePixelRatio', 'innerWidth', 'innerHeight',
    'scrollTo', 'open', 'close', 'getSelection', 'DOMParser', 'XMLSerializer', 'Option', 'Audio', 'CSS',
    'CanvasRenderingContext2D', 'OffscreenCanvas', 'ImageData', 'Path2D', 'DOMRect', 'DOMMatrix', 'Notification',
    'caches', 'visualViewport', 'customElements', 'print', 'self', 'importScripts', 'requestIdleCallback',
    'cancelIdleCallback', 'FileReader', 'File',
    'L', 'turf', 'proj4', 'THREE', 'ethers', 'solanaWeb3', 'pako', 'module', 'exports', 'require', 'define'
];
const BUILTINS = new Set([...Object.getOwnPropertyNames(globalThis), ...BROWSER_GLOBALS, 'arguments', 'undefined']);

function listJsFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return listJsFiles(full);
        return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
    });
}

function walk(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(child => walk(child, visit));
        else if (value && typeof value.type === 'string') walk(value, visit);
    }
}

function bindingNames(pattern, out) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') out.add(pattern.name);
    else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(p => bindingNames(p.type === 'RestElement' ? p.argument : p.value, out));
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(e => bindingNames(e, out));
    else if (pattern.type === 'AssignmentPattern') bindingNames(pattern.left, out);
    else if (pattern.type === 'RestElement') bindingNames(pattern.argument, out);
}

function objectKeys(objectExpression, out) {
    for (const property of objectExpression.properties || []) {
        if (property.key && property.key.type === 'Identifier') out.add(property.key.name);
    }
}

export function scanFrontend(files) {
    const declaredAnywhere = new Set();
    const perFile = [];
    for (const file of files) {
        const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'unambiguous', errorRecovery: true });
        const local = new Set();
        const optional = new Set();
        const used = [];
        const objectLiterals = new Map(); // const api = { ... } → its keys, for Object.assign(global, api)
        walk(ast.program, node => {
            if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassMethod', 'ObjectMethod'].includes(node.type)) {
                if (node.id) local.add(node.id.name);
                node.params.forEach(param => bindingNames(param, local));
            }
            if (node.type === 'ClassDeclaration' && node.id) local.add(node.id.name);
            if (node.type === 'VariableDeclarator') {
                bindingNames(node.id, local);
                if (node.id.type === 'Identifier' && node.init && node.init.type === 'ObjectExpression') {
                    const keys = new Set();
                    objectKeys(node.init, keys);
                    objectLiterals.set(node.id.name, keys);
                }
            }
            if (node.type === 'CatchClause' && node.param) bindingNames(node.param, local);
            if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(node.type)) local.add(node.local.name);
            if (node.type === 'UnaryExpression' && node.operator === 'typeof' && node.argument.type === 'Identifier') optional.add(node.argument.name);
            if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && !node.left.computed && node.left.property.type === 'Identifier') {
                declaredAnywhere.add(node.left.property.name);
            }
            if (node.type === 'MemberExpression' && node.computed && node.property.type === 'StringLiteral') declaredAnywhere.add(node.property.value);
            if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier'
                && node.callee.object.name === 'Object' && node.callee.property.name === 'assign') {
                node.arguments.slice(1).forEach(argument => {
                    if (argument.type === 'ObjectExpression') objectKeys(argument, declaredAnywhere);
                    if (argument.type === 'Identifier') used.push({ assignSource: argument.name });
                });
            }
            if (node.type === 'CallExpression' && node.callee.type === 'Identifier') used.push({ name: node.callee.name, line: node.loc.start.line });
            if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier') used.push({ name: node.object.name, line: node.loc.start.line });
        });
        for (const entry of used) {
            if (entry.assignSource && objectLiterals.has(entry.assignSource)) objectLiterals.get(entry.assignSource).forEach(key => declaredAnywhere.add(key));
        }
        for (const node of ast.program.body) {
            if (node.type === 'FunctionDeclaration' && node.id) declaredAnywhere.add(node.id.name);
            if (node.type === 'ClassDeclaration' && node.id) declaredAnywhere.add(node.id.name);
            if (node.type === 'VariableDeclaration') node.declarations.forEach(declaration => bindingNames(declaration.id, declaredAnywhere));
        }
        perFile.push({ file: path.relative(ROOT, file), local, optional, used: used.filter(entry => entry.name) });
    }
    const undeclared = new Set();
    for (const { file, local, optional, used } of perFile) {
        for (const { name, line } of used) {
            if (local.has(name) || declaredAnywhere.has(name) || BUILTINS.has(name) || optional.has(name)) continue;
            undeclared.add(`${file}:${line} ${name}`);
        }
    }
    return [...undeclared].sort();
}

describe('frontend names that exist nowhere', () => {
    const files = listJsFiles(FRONTEND_JS);

    it('scans the frontend scripts', () => {
        expect(files.length).toBeGreaterThan(100);
    });

    it('every called function and every member-accessed object is declared somewhere', () => {
        expect(scanFrontend(files)).toEqual([]);
    });
});
