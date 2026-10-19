import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { vocabularyDocument, NAMESPACE } from '../semantics/vocabulary.js';

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const styles = `:root{color-scheme:light;font-family:system-ui,sans-serif;color:#192f38;background:#f5f6f2}*{box-sizing:border-box}body{margin:0}main{max-width:1060px;margin:0 auto;padding:56px 24px 80px}a{color:#07666d;text-underline-offset:3px}header{border-bottom:2px solid #b8cac7;padding-bottom:30px;margin-bottom:30px}.eyebrow{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#426a68}h1{font-size:clamp(32px,6vw,54px);letter-spacing:-.035em;margin:12px 0}h2{margin-top:44px;font-size:25px}p{line-height:1.65;max-width:80ch}nav{display:flex;flex-wrap:wrap;gap:12px 24px;margin-top:22px}article{display:grid;grid-template-columns:260px 1fr;gap:20px;border-top:1px solid #cedbd6;padding:19px 0;scroll-margin-top:20px}article h3{font-size:16px;margin:0 0 6px}article p{margin:0}code{font-size:12px;overflow-wrap:anywhere;color:#48645f}.meta{font-size:13px;color:#48645f;margin-top:8px}.note{border-left:3px solid #4d8c80;padding:4px 18px;margin:26px 0}footer{border-top:2px solid #b8cac7;margin-top:40px;padding-top:20px;font-size:13px}@media(max-width:650px){main{padding:28px 20px 50px}article{grid-template-columns:1fr;gap:6px}}`;
const page = (title, content, alternate = '') => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>${alternate ? `<link rel="alternate" type="application/ld+json" href="${escapeHtml(alternate)}">` : ''}<style>${styles}</style></head><body><main>${content}</main></body></html>\n`;

export function vocabularyArtifacts() {
    const document = vocabularyDocument();
    const groups = [
        ['classes', 'Record and reference classes', 'rdfs:Class'],
        ['properties', 'Relationships and values', 'rdf:Property'],
        ['concepts', 'Controlled concepts', 'skos:Concept']
    ];
    const terms = groups.map(([id, title, type]) => `<section id="${id}"><h2>${title}</h2>${document['@graph'].filter(node => node['@type'] === type).map(node => {
        const key = node['@id'].slice(3);
        const label = node['rdfs:label'] || node['skos:prefLabel'];
        const definition = node['rdfs:comment'] || node['skos:definition'];
        const range = node['rdfs:range']?.['@id'];
        const scheme = node['skos:inScheme']?.['@id'];
        return `<article id="${escapeHtml(key)}"><div><h3><a href="#${escapeHtml(key)}">${escapeHtml(label)}</a></h3><code>cb:${escapeHtml(key)}</code></div><div><p>${escapeHtml(definition)}</p>${range || scheme ? `<p class="meta">${range ? 'Range' : 'Scheme'}: ${escapeHtml(range || scheme)}</p>` : ''}</div></article>`;
    }).join('')}</section>`).join('');
    // Concept schemes have dereferenceable anchors too, without duplicating their member lists.
    const schemes = document['@graph'].filter(node => node['@type'] === 'skos:ConceptScheme').map(node => `<span id="${node['@id'].slice(3)}">${node['rdfs:label']}</span>`).join(' · ');
    const header = `<header><div class="eyebrow">Urban Game Theory · Data vocabulary</div><h1>What the records mean</h1><p>Version 1 defines the terms used by the published proposal and named-plan JSON-LD views. Records, geographic extents, declarations and commitments have distinct meanings.</p><nav><a href="vocabulary.jsonld">Download JSON-LD definitions</a><a href="#classes">Classes</a><a href="#properties">Properties</a><a href="#concepts">Concepts</a></nav></header>`;
    const usage = `<section><h2>Read a published record</h2><p>Append <code>?format=jsonld</code> to a proposal or named-plan detail URL on the API: <code>/proposals/{rowId}?format=jsonld</code> or <code>/plans/{slug}?format=jsonld</code>. Each response includes its context, so a consumer can expand it without fetching a remote context.</p><p>Record IRIs use the deployment's configured canonical API URL. Row IDs are scoped to that publication store. Authored IDs, chain locations and member hashes are separate values.</p><div class="note"><p>A recorded lifecycle is not independent evidence of execution. An authored site is not a legal parcel boundary. A saved member hash commits to the application's member content, not to every field in the JSON-LD view. These exports make no assertion of ownership, consent or physical construction.</p></div><p><code>${NAMESPACE}</code></p></section>`;
    const footer = `<footer><p>Mappings reuse <a href="https://schema.org/CreativeWork">Schema.org</a>, <a href="https://www.w3.org/TR/prov-o/">PROV</a>, <a href="https://docs.ogc.org/is/22-047r1/22-047r1.html">GeoSPARQL 1.1</a> and <a href="https://www.w3.org/TR/skos-reference/">SKOS</a>. Site GeoJSON uses CRS84 longitude, latitude. The vocabulary is not a legal, spatial or signature validation service.</p></footer>`;
    return new Map([
        ['1/vocabulary.jsonld', `${JSON.stringify(document, null, 2)}\n`],
        ['1/index.html', page('Urban Game Theory vocabulary · Version 1', `${header}${usage}${terms}<p class="meta">Concept schemes: ${schemes}</p>${footer}`, 'vocabulary.jsonld')],
        ['index.html', page('Urban Game Theory vocabulary', '<header><div class="eyebrow">Urban Game Theory · Data vocabulary</div><h1>Vocabulary</h1><p>Definitions for published proposal records and named-plan commitments.</p><nav><a href="1/">Read version 1</a><a href="1/vocabulary.jsonld">JSON-LD definitions</a></nav></header><p>Versioned term identifiers preserve the meaning of exported data. Record identifiers use the canonical URL of their publication API.</p>')]
    ]);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const root = new URL('../../frontend/vocabulary/', import.meta.url);
    await mkdir(new URL('1/', root), { recursive: true });
    for (const [path, content] of vocabularyArtifacts()) await writeFile(new URL(path, root), content);
    console.log(`Generated vocabulary in ${fileURLToPath(root).split('/').slice(-3).join('/')}`);
}
