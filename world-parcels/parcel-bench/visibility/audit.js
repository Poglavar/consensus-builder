// Visibility audit page logic: loads the sample from /audit, draws the parcel outline over the tile image,
// posts labels to /label and moves on to the next unlabelled parcel.
(function () {
  const SVG = 'http://www.w3.org/2000/svg';
  const MIN_WINDOW_PX = 200;   // close-up never narrower than 200 px of the 1024 px tile (about 30 m)
  let audit = null, index = 0;

  const el = (id) => document.getElementById(id);
  const node = (name, attrs) => {
    const n = document.createElementNS(SVG, name);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    return n;
  };

  function bounds(rings) {
    const xs = rings.flat().map((p) => p[0]), ys = rings.flat().map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  function closeUpViewBox(rings, size) {
    const [x0, y0, x1, y1] = bounds(rings);
    const side = Math.min(size, Math.max(MIN_WINDOW_PX, 1.6 * Math.max(x1 - x0, y1 - y0)));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const left = Math.min(Math.max(cx - side / 2, 0), size - side), top = Math.min(Math.max(cy - side / 2, 0), size - side);
    return `${left} ${top} ${side} ${side}`;
  }

  // A reference clipped by the tile has sides along the image border; those are the tile cut, not a parcel
  // boundary, so the outline skips them instead of drawing a line nobody can see on the ground.
  function onBorder(a, b, size) {
    const near = (v, edge) => Math.abs(v - edge) < 0.6;
    return [0, size].some((edge) => (near(a[0], edge) && near(b[0], edge)) || (near(a[1], edge) && near(b[1], edge)));
  }

  function outlinePath(ring, size) {
    let d = `M${ring[0].join(' ')}`;
    for (let k = 1; k < ring.length; k += 1) {
      d += `${onBorder(ring[k - 1], ring[k], size) ? 'M' : 'L'}${ring[k].join(' ')}`;
    }
    return d;
  }

  function draw(svg, item, viewBox, strokePx) {
    svg.replaceChildren();
    svg.setAttribute('viewBox', viewBox);
    svg.appendChild(node('image', { href: `/image/${item.tile}`, x: 0, y: 0, width: item.size, height: item.size }));
    item.rings.forEach((ring) => {
      const d = outlinePath(ring, item.size);
      svg.appendChild(node('path', { class: 'ring-halo', d, 'stroke-width': strokePx * 2.2 }));
      svg.appendChild(node('path', { class: 'ring', d, 'stroke-width': strokePx }));
    });
  }

  function render() {
    const item = audit.items[index];
    const labelled = audit.items.filter((i) => i.label).length;
    el('progress').textContent = `${labelled}/${audit.items.length} labelled`;
    el('position').textContent = `parcel ${index + 1} of ${audit.items.length} · ${item.tile} · ${item.reference} · ${item.area_m2} m²`;
    const box = closeUpViewBox(item.rings, item.size).split(' ').map(Number);
    draw(el('zoom'), item, box.join(' '), box[2] / 300);
    draw(el('context'), item, `0 0 ${item.size} ${item.size}`, 3);
    document.querySelectorAll('.buttons button').forEach((b) => b.classList.toggle('chosen', b.dataset.label === item.label));
  }

  async function label(value) {
    const item = audit.items[index];
    el('status').textContent = 'saving…';
    const response = await fetch('/label', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index, tile: item.tile, reference: item.reference, label: value }),
    });
    const result = await response.json();
    if (!response.ok) { el('status').textContent = `not saved: ${result.error}`; return; }
    if (value) item.label = value; else delete item.label;
    el('status').textContent = `saved (${result.labelled}/${result.total})`;
    if (value) {
      const next = audit.items.findIndex((i, k) => k > index && !i.label);
      index = next >= 0 ? next : Math.min(index + 1, audit.items.length - 1);
    }
    render();
  }

  function move(step) { index = Math.min(Math.max(index + step, 0), audit.items.length - 1); render(); }

  document.addEventListener('keydown', (event) => {
    if (!audit) return;
    const number = '01234'.indexOf(event.key);
    if (number === 0) label(null);
    else if (number > 0) label(audit.classes[number - 1]);
    else if (event.key === 'ArrowRight') move(1);
    else if (event.key === 'ArrowLeft') move(-1);
    else if (event.key === 'h' || event.key === 'H') document.body.classList.toggle('hidden');
  });

  fetch('/audit').then((r) => r.json()).then((data) => {
    audit = data;
    el('title').textContent = `Visibility audit · ${data.benchmark}`;
    data.classes.forEach((name, k) => {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.label = name; button.textContent = `${k + 1} ${name}`;
      button.addEventListener('click', () => label(name));
      el('buttons').appendChild(button);
      const dt = document.createElement('dt'); dt.textContent = name;
      const dd = document.createElement('dd'); dd.textContent = data.definitions[name];
      el('definitions').append(dt, dd);
    });
    const first = data.items.findIndex((i) => !i.label);
    index = first >= 0 ? first : 0;
    render();
  });
})();
