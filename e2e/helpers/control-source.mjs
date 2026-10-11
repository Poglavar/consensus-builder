// Give authored buttons stable source identities in the test server without changing app handlers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const { parse } = require('@babel/parser');
export const frontendRoot = fileURLToPath(new URL('../../frontend/', import.meta.url));
const hasButtonClass = value => String(value || '').split(/\s+/).some(name =>
  /(?:^|-)(?:btn|button)(?:-|$)/.test(name) || name === 'wallet-attest-link');

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'extra' || key === 'comments' || key.endsWith('Comments')) continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

export function instrumentControls(source, filename) {
  const sites = [];
  const edits = [];
  const repetitions = new Map();
  const add = (offset, snippet, kind, end, insertion = offset + 7, receiver = null) => {
    const signature = snippet.replace(/\s+/g, ' ').trim();
    const hash = crypto.createHash('sha256').update(`${filename}\n${kind}\n${signature}`).digest('hex').slice(0, 14);
    const count = (repetitions.get(hash) || 0) + 1;
    repetitions.set(hash, count);
    const id = `control-${hash}-${count}`;
    sites.push({ id, source: filename, line: source.slice(0, offset).split('\n').length, kind, markup: signature });
    if (kind === 'element') {
      // The unquoted attribute contains only ASCII letters, digits and hyphens. It is safe inside
      // HTML, single/double-quoted JavaScript strings and template literals alike.
      edits.push({ start: insertion, end: insertion, value: ` data-ui-control=${id}` });
    } else if (kind === 'role') {
      edits.push({ start: offset, end, value: `((e)=>(e.setAttribute('data-ui-control',[(e.getAttribute('data-ui-control')||''),'${id}'].filter(Boolean).join(' ')),e.setAttribute('role','button')))(${receiver})` });
    } else {
      const original = source.slice(offset, end);
      // A generic factory may set role=button after createElement returns (for example a
      // transaction row). Mark its created node now; the recorder only observes button roles.
      edits.push({ start: offset, end, value: `((e)=>(e.setAttribute('data-ui-control','${id}'),e))(${original})` });
    }
  };
  const markup = (text, offset) => {
    for (const match of text.matchAll(/<([a-z][\w:-]*)\b/gi)) {
      const start = offset + match.index;
      // An interpolated attribute splits a template into several quasis. The opening token is
      // enough to locate the button; requiring its '>' in this quasi misses dynamic controls.
      const end = source.indexOf('>', start);
      const snippet = source.slice(start, end < 0 ? start + match[0].length : end + 1);
      const tag = match[1].toLowerCase();
      const classes = snippet.match(/\bclass\s*=\s*\\?(["'])(.*?)\\?\1/)?.[2];
      if (tag !== 'button' && !/\brole\s*=\s*\\?["']button\\?["']/.test(snippet)
          && !(tag === 'a' && hasButtonClass(classes))
          && !(tag === 'input' && /\btype\s*=\s*\\?["'](?:button|submit|reset)\\?["']/.test(snippet))) continue;
      add(start, snippet, 'element', undefined, start + match[0].length);
    }
  };
  const javascript = (text, offset = 0) => {
    const ast = parse(text, { sourceType: 'unambiguous', allowReturnOutsideFunction: true });
    const anchorButtons = new Set();
    walk(ast.program, node => {
      if (!['Program', 'BlockStatement'].includes(node.type)) return;
      // Resolve the common createElement('a') + className idiom in the same lexical block.
      // Keeping declarations local prevents a same-named ordinary link in another function
      // from inheriting a button's coverage obligation.
      const anchors = new Map();
      const anchorCreation = (name, init) => {
        if (name && init?.type === 'CallExpression' && init.callee?.type === 'MemberExpression'
            && init.callee.property?.name === 'createElement' && init.arguments?.[0]?.value === 'a') anchors.set(name, init);
      };
      for (const statement of node.body) {
        for (const declaration of statement.type === 'VariableDeclaration' ? statement.declarations : []) {
          if (declaration.id.type === 'Identifier') anchorCreation(declaration.id.name, declaration.init);
        }
        const assignment = statement.type === 'ExpressionStatement' ? statement.expression : null;
        if (assignment?.type === 'AssignmentExpression' && assignment.left?.type === 'Identifier') {
          anchorCreation(assignment.left.name, assignment.right);
        }
        if (assignment?.type === 'AssignmentExpression' && assignment.left?.type === 'MemberExpression'
            && assignment.left.property?.name === 'className' && assignment.right?.type === 'StringLiteral'
            && hasButtonClass(assignment.right.value)) {
          const anchor = anchors.get(assignment.left.object?.name);
          if (anchor) anchorButtons.add(anchor);
        }
      }
    });
    walk(ast.program, node => {
      if (node.type === 'StringLiteral' || node.type === 'TemplateElement') {
        markup(text.slice(node.start, node.end), offset + node.start);
      }
      if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression'
          && !node.callee.computed && node.callee.property?.name === 'createElement'
          && node.arguments?.[0] && (node.arguments[0].type !== 'StringLiteral' || node.arguments[0].value === 'button' || anchorButtons.has(node))) {
        add(offset + node.start, text.slice(node.start, node.end), node.arguments[0].type === 'StringLiteral' ? 'factory' : 'factory-dynamic', offset + node.end);
      }
      if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression'
          && !node.callee.computed && node.callee.property?.name === 'setAttribute'
          && node.arguments?.[0]?.value === 'role' && node.arguments?.[1]?.value === 'button'
          && ['Identifier', 'MemberExpression'].includes(node.callee.object.type)) {
        add(offset + node.start, text.slice(node.start, node.end), 'role', offset + node.end, undefined,
          text.slice(node.callee.object.start, node.callee.object.end));
      }
    });
  };
  if (/\.m?js$/.test(filename)) javascript(source);
  else {
    // Comments and script bodies are excluded from the HTML pass, then executable script bodies
    // are parsed separately so a comment mentioning <button> never becomes a coverage obligation.
    let masked = source.replace(/<!--[\s\S]*?-->/g, match => ' '.repeat(match.length));
    masked = masked.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (whole, attrs, body, index) => {
      if (body.trim() && !/type\s*=\s*["'](?:application\/ld\+json|application\/json|importmap)/i.test(attrs)) {
        javascript(body, index + whole.indexOf('>') + 1);
      }
      return ' '.repeat(whole.length);
    });
    markup(masked, 0);
  }
  let code = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    code = code.slice(0, edit.start) + edit.value + code.slice(edit.end);
  }
  return { code, sites };
}

export function sourceFiles(root = frontendRoot) {
  const files = [];
  const descend = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) descend(full);
      else if (/\.m?js$/.test(entry.name)) files.push(full);
    }
  };
  descend(path.join(root, 'js'));
  for (const entry of fs.readdirSync(root)) if (entry.endsWith('.html')) files.push(path.join(root, entry));
  return files.sort();
}

export function sourceInventory(root = frontendRoot) {
  return sourceFiles(root).flatMap(file => instrumentControls(fs.readFileSync(file, 'utf8'), path.relative(root, file)).sites);
}
