// A small DOM for node tests of browser editors that build their UI from HTML templates: elements
// with attributes, classList, dataset, style, children, events, innerHTML parsing and simple
// querySelector(All) (tag, #id, .class, [attr], [attr="value"], compounds and comma lists — no
// combinators: an unsupported selector throws, so a test cannot pass by matching nothing).

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'col', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
    return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
        if (code[0] === '#') {
            const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(n) ? String.fromCodePoint(n) : match;
        }
        return Object.prototype.hasOwnProperty.call(ENTITIES, code) ? ENTITIES[code] : match;
    });
}

function escapeText(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function camelToData(name) {
    return 'data-' + name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
}

class FakeText {
    constructor(text) { this.nodeType = 3; this.data = String(text); this.parentNode = null; }
    get textContent() { return this.data; }
    set textContent(value) { this.data = String(value); }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}

// Parses an HTML fragment into nodes appended to `parent`.
function parseInto(parent, html, doc) {
    const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
    const attr = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    const stack = [parent];
    let match;
    while ((match = token.exec(String(html)))) {
        const top = stack[stack.length - 1];
        if (match[0].startsWith('<!--')) continue;
        if (match[1]) {
            const name = match[1].toUpperCase();
            for (let i = stack.length - 1; i > 0; i -= 1) {
                if (stack[i].tagName === name) { stack.length = i; break; }
            }
            continue;
        }
        if (match[2]) {
            const element = doc.createElement(match[2]);
            let a;
            attr.lastIndex = 0;
            while ((a = attr.exec(match[3] || ''))) {
                const value = a[2] ?? a[3] ?? a[4] ?? '';
                element.setAttribute(a[1], decodeEntities(value));
            }
            top.appendChild(element);
            if (!match[4] && !VOID_TAGS.has(match[2].toLowerCase())) stack.push(element);
            continue;
        }
        if (match[5] && match[5].length) top.appendChild(new FakeText(decodeEntities(match[5])));
    }
}

// One compound selector (no combinators) → predicate.
function compileCompound(selector) {
    const parts = [];
    const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/gy;
    let index = 0;
    let match;
    while (index < selector.length) {
        re.lastIndex = index;
        match = re.exec(selector);
        if (!match) throw new Error(`fake-dom: unsupported selector "${selector}"`);
        if (match[1]) { const tag = match[1].toUpperCase(); parts.push(el => el.tagName === tag); }
        else if (match[2]) { const id = match[2]; parts.push(el => el.getAttribute('id') === id); }
        else if (match[3]) { const cls = match[3]; parts.push(el => el.classList.contains(cls)); }
        else {
            const name = match[4];
            const value = match[5] ?? match[6] ?? match[7];
            parts.push(value === undefined ? el => el.hasAttribute(name) : el => el.getAttribute(name) === value);
        }
        index = re.lastIndex;
    }
    return el => parts.every(test => test(el));
}

function compile(selector) {
    const groups = String(selector).split(',').map(part => part.trim()).filter(Boolean);
    if (!groups.length) throw new Error('fake-dom: empty selector');
    const tests = groups.map(compileCompound);
    return el => tests.some(test => test(el));
}

class FakeElement {
    constructor(tagName, doc) {
        this.nodeType = 1;
        this.tagName = String(tagName).toUpperCase();
        this.ownerDocument = doc;
        this.attributes = new Map();
        this.childNodes = [];
        this.parentNode = null;
        this.listeners = new Map();
        this._value = '';
        this.checked = false;
        this.isContentEditable = false;
        const style = {};
        Object.defineProperties(style, {
            setProperty: { value: (name, value) => { style[name] = String(value); } },
            removeProperty: { value: name => { delete style[name]; } },
            getPropertyValue: { value: name => style[name] || '' }
        });
        this.style = style;
        const self = this;
        this.dataset = new Proxy({}, {
            get: (_t, key) => (typeof key === 'string' ? (self.getAttribute(camelToData(key)) ?? undefined) : undefined),
            set: (_t, key, value) => { self.setAttribute(camelToData(String(key)), String(value)); return true; },
            deleteProperty: (_t, key) => { self.removeAttribute(camelToData(String(key))); return true; }
        });
        this.classList = {
            add: (...names) => names.forEach(name => { const list = self._classes(); if (!list.includes(name)) self._setClasses([...list, name]); }),
            remove: (...names) => self._setClasses(self._classes().filter(name => !names.includes(name))),
            contains: name => self._classes().includes(name),
            toggle: (name, force) => {
                const on = force === undefined ? !self.classList.contains(name) : !!force;
                if (on) self.classList.add(name); else self.classList.remove(name);
                return on;
            }
        };
    }

    _classes() { return (this.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
    _setClasses(list) { this.setAttribute('class', list.join(' ')); }

    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(value) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
    get value() { return this._value; }
    set value(value) { this._value = String(value); }
    get valueAsNumber() { return this._value === '' ? NaN : Number(this._value); }
    get validity() { return { valid: this._value === '' || Number.isFinite(Number(this._value)) }; }
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get cells() { return this.children.filter(child => child.tagName === 'TD' || child.tagName === 'TH'); }
    get firstChild() { return this.childNodes[0] || null; }

    setAttribute(name, value) {
        const key = String(name).toLowerCase();
        this.attributes.set(key, String(value));
        if (key === 'value') this._value = String(value);
        if (key === 'checked') this.checked = true;
    }
    getAttribute(name) { const key = String(name).toLowerCase(); return this.attributes.has(key) ? this.attributes.get(key) : null; }
    hasAttribute(name) { return this.attributes.has(String(name).toLowerCase()); }
    removeAttribute(name) { this.attributes.delete(String(name).toLowerCase()); }
    toggleAttribute(name, force) {
        const on = force === undefined ? !this.hasAttribute(name) : !!force;
        if (on) this.setAttribute(name, ''); else this.removeAttribute(name);
        return on;
    }

    // Reflected attributes the editors set as properties.
    get type() { return this.getAttribute('type') || ''; }
    set type(value) { this.setAttribute('type', value); }
    get name() { return this.getAttribute('name') || ''; }
    set name(value) { this.setAttribute('name', value); }
    get title() { return this.getAttribute('title') || ''; }
    set title(value) { this.setAttribute('title', value); }
    get min() { return this.getAttribute('min') || ''; }
    set min(value) { this.setAttribute('min', value); }
    get max() { return this.getAttribute('max') || ''; }
    set max(value) { this.setAttribute('max', value); }
    get step() { return this.getAttribute('step') || ''; }
    set step(value) { this.setAttribute('step', value); }

    appendChild(node) {
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = this;
        this.childNodes.push(node);
        return node;
    }
    append(...nodes) { nodes.forEach(node => this.appendChild(typeof node === 'string' ? new FakeText(node) : node)); }
    removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index >= 0) this.childNodes.splice(index, 1);
        node.parentNode = null;
        return node;
    }
    replaceChildren(...nodes) { [...this.childNodes].forEach(node => this.removeChild(node)); this.append(...nodes); }
    insertAdjacentElement(_where, element) { return this.parentNode ? this.parentNode.appendChild(element) : null; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    contains(node) {
        for (let current = node; current; current = current.parentNode) if (current === this) return true;
        return false;
    }

    get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); if (value !== '' && value !== null && value !== undefined) this.appendChild(new FakeText(value)); }
    get innerText() { return this.textContent; }
    get innerHTML() {
        return this.childNodes.map(node => {
            if (node.nodeType === 3) return escapeText(node.data);
            const tag = node.tagName.toLowerCase();
            const attrs = [...node.attributes].map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)).join('');
            return VOID_TAGS.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${node.innerHTML}</${tag}>`;
        }).join('');
    }
    set innerHTML(html) { this.replaceChildren(); parseInto(this, html, this.ownerDocument); }

    *_descendants() {
        for (const child of this.children) { yield child; yield* child._descendants(); }
    }
    querySelectorAll(selector) { const test = compile(selector); return [...this._descendants()].filter(test); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) {
        const test = compile(selector);
        for (let current = this; current && current.nodeType === 1; current = current.parentNode) if (test(current)) return current;
        return null;
    }
    matches(selector) { return compile(selector)(this); }

    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatchEvent(event) {
        if (!event.target) event.target = this;
        event.currentTarget = this;
        (this.listeners.get(event.type) || []).forEach(fn => fn.call(this, event));
        // Bubble, like the DOM does for the change/input/click events the editors listen to.
        if (event.bubbles !== false && this.parentNode && this.parentNode.dispatchEvent && !event._stopped) this.parentNode.dispatchEvent(event);
        return !event.defaultPrevented;
    }
    click() {
        if (this.disabled) return;
        if (this.tagName === 'INPUT' && (this.type === 'checkbox' || this.type === 'radio')) {
            this.checked = this.type === 'radio' ? true : !this.checked;
            this.dispatchEvent(makeEvent('change', { target: this }));
        }
        this.dispatchEvent(makeEvent('click', { target: this }));
    }
    focus() {} blur() {} scrollIntoView() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 }; }
}

export function makeEvent(type, init = {}) {
    return {
        type, bubbles: true, defaultPrevented: false, _stopped: false, key: '', repeat: false,
        ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
        ...init,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this._stopped = true; },
        stopImmediatePropagation() { this._stopped = true; }
    };
}

// A document: createElement, a body, and lookups over everything attached to the body.
export function makeDocument() {
    const doc = {
        createElement: tag => new FakeElement(tag, doc),
        createTextNode: text => new FakeText(text),
        listeners: new Map()
    };
    doc.documentElement = new FakeElement('html', doc);
    doc.body = new FakeElement('body', doc);
    doc.documentElement.appendChild(doc.body);
    doc.getElementById = id => doc.documentElement.querySelector(`#${id}`);
    doc.querySelector = selector => doc.documentElement.querySelector(selector);
    doc.querySelectorAll = selector => doc.documentElement.querySelectorAll(selector);
    doc.contains = node => doc.documentElement.contains(node);
    doc.addEventListener = (type, fn) => { if (!doc.listeners.has(type)) doc.listeners.set(type, new Set()); doc.listeners.get(type).add(fn); };
    doc.removeEventListener = (type, fn) => { doc.listeners.get(type)?.delete(fn); };
    doc.dispatchEvent = event => { (doc.listeners.get(event.type) || []).forEach(fn => fn(event)); return true; };
    return doc;
}

export { FakeElement, FakeText };
