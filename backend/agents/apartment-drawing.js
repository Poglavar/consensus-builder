// The unit drawing a developer agent attaches to each apartment it lists (funding.apartments.units[].
// drawing, a PDF): one A4 page with the storey's apartment partition from the generated layout, the
// listed apartment filled, its label, storey, area and rooms. Written by hand as a minimal PDF 1.4 so
// the bytes are deterministic (the drawing is part of the agreement's CID); no PDF library needed.

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;

// PDF text strings: Helvetica's standard encoding covers ASCII, so anything else is replaced.
function pdfText(value) {
    return String(value).replace(/[^\x20-\x7e]/g, '-').replace(/([()\\])/g, '\\$1');
}

const num = value => (Math.round(value * 100) / 100).toString();

/** Polygon paths of normalized [u, v] rings, scaled into a box at (x, y) of w × h, as PDF path operators. */
function ringPaths(polygons, box) {
    const ops = [];
    for (const polygon of polygons || []) {
        for (const ring of polygon || []) {
            ring.forEach(([u, v], i) => ops.push(`${num(box.x + u * box.w)} ${num(box.y + (1 - v) * box.h)} ${i ? 'l' : 'm'}`));
            if (ring.length) ops.push('h');
        }
    }
    return ops;
}

/**
 * One-page PDF bytes (Buffer) for an apartment: `apartment` from apartment-units.js designApartments,
 * `label` the buyer-facing name, `project` a line naming the plan and building.
 */
export function apartmentDrawingPdf({ apartment, label, project = '' }) {
    const [widthM, depthM] = Array.isArray(apartment.dimensionsM) ? apartment.dimensionsM : [1, 1];
    const scale = Math.min((PAGE_W - 2 * MARGIN) / (widthM || 1), (PAGE_H - 300) / (depthM || 1));
    const box = { x: MARGIN, y: 120, w: (widthM || 1) * scale, h: (depthM || 1) * scale };
    const others = (apartment.storeyRegions || []).filter(region => region.id !== apartment.region?.id);
    const rooms = (apartment.rooms || []).map(room => `${room.kind} ${num(room.areaM2)} m2`).join(', ');
    const lines = [
        ['F2', 18, label],
        ['F1', 11, project],
        ['F1', 11, `Storey ${apartment.level} - unit ${apartment.unitSlot} - ${num(apartment.areaM2)} m2`],
        ['F1', 9, rooms ? `Rooms: ${rooms}` : ''],
        ['F1', 8, 'Generated default layout (X-ray Suggested layouts); dimensions are estimates, not a survey.']
    ].filter(([, , text]) => text);
    const content = [
        '0.6 G 0.5 w', ...others.flatMap(region => ringPaths(region.polygons, box)), 'S',
        '0.85 0.92 1 rg 0.1 0.3 0.6 RG 1.2 w', ...ringPaths(apartment.region?.polygons, box), 'B',
        'BT', ...lines.map(([font, size, text], i) => `/${font} ${size} Tf 1 0 0 1 ${MARGIN} ${PAGE_H - MARGIN - 22 * i} Tm 0 g (${pdfText(text)}) Tj`), 'ET'
    ].join('\n');
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
        `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`
    ];
    let body = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((object, i) => {
        offsets.push(Buffer.byteLength(body, 'latin1'));
        body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = Buffer.byteLength(body, 'latin1');
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(body, 'latin1');
}
