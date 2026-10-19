const NS = 'http://www.w3.org/2000/svg';
function element(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
export class ImageViewer {
  constructor(svg, { onTap, onLoad }) {
    this.svg = svg; this.onTap = onTap; this.onLoad = onLoad;
    this.image = element('image'); this.overlay = element('g');
    svg.append(this.image, this.overlay);
    this.points = new Map(); this.annotations = {};
    this.image.addEventListener('load', () => onLoad(true));
    this.image.addEventListener('error', () => onLoad(false));
    svg.addEventListener('pointerdown', event => this.down(event));
    svg.addEventListener('pointermove', event => this.move(event));
    svg.addEventListener('pointerup', event => this.up(event));
    svg.addEventListener('pointercancel', event => this.up(event, true));
    svg.addEventListener('wheel', event => { event.preventDefault(); this.zoom(Math.exp(-event.deltaY / 400), this.local(event)); }, { passive: false });
    new ResizeObserver(() => this.fit()).observe(svg);
  }
  show(sample) {
    if (this.sample?.id === sample.id) return;
    this.sample = sample;
    this.onLoad(null);
    this.image.setAttribute('width', sample.width);
    this.image.setAttribute('height', sample.height);
    this.image.setAttribute('href', `${sample.image}?v=${sample.image_sha256}`);
    this.fit();
  }
  local(event) { const r = this.svg.getBoundingClientRect(); return [event.clientX - r.left, event.clientY - r.top]; }
  imagePoint(point, box = this.box) {
    const r = this.svg.getBoundingClientRect();
    return [box.x + point[0] / r.width * box.w, box.y + point[1] / r.height * box.h];
  }
  fit() {
    if (!this.sample) return;
    const r = this.svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const unit = Math.max(this.sample.width / r.width, this.sample.height / r.height);
    this.fitWidth = r.width * unit;
    this.box = { x: (this.sample.width - this.fitWidth) / 2, y: (this.sample.height - r.height * unit) / 2, w: this.fitWidth, h: r.height * unit };
    this.draw();
  }
  zoom(factor, at) {
    if (!this.box) return;
    const r = this.svg.getBoundingClientRect();
    at ||= [r.width / 2, r.height / 2];
    const anchor = this.imagePoint(at), w = Math.max(this.fitWidth / 16, Math.min(this.fitWidth, this.box.w / factor));
    const h = w * r.height / r.width;
    this.box = { x: anchor[0] - at[0] / r.width * w, y: anchor[1] - at[1] / r.height * h, w, h };
    this.draw();
  }
  baseline() {
    this.startBox = { ...this.box };
    this.startPoints = [...this.points.values()].map(p => [...p]);
  }
  down(event) {
    if (!this.box) return;
    event.preventDefault(); this.svg.setPointerCapture(event.pointerId);
    const point = this.local(event); this.points.set(event.pointerId, point);
    if (this.points.size === 1) { this.tapStart = point; this.moved = false; }
    else this.moved = true;
    this.baseline();
  }
  move(event) {
    if (!this.points.has(event.pointerId)) return;
    const point = this.local(event); this.points.set(event.pointerId, point);
    if (Math.hypot(point[0] - this.tapStart[0], point[1] - this.tapStart[1]) > 8) this.moved = true;
    const now = [...this.points.values()], start = this.startPoints, r = this.svg.getBoundingClientRect();
    if (now.length >= 2 && start.length >= 2) {
      const center = pts => [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
      const distance = pts => Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
      const first = center(start), current = center(now), anchor = this.imagePoint(first, this.startBox);
      const w = Math.min(this.fitWidth, Math.max(this.fitWidth / 16, this.startBox.w * Math.max(1, distance(start)) / Math.max(1, distance(now))));
      const h = w * r.height / r.width;
      this.box = { x: anchor[0] - current[0] / r.width * w, y: anchor[1] - current[1] / r.height * h, w, h };
    } else if (this.moved) this.box = { ...this.startBox,
      x: this.startBox.x - (point[0] - start[0][0]) / r.width * this.startBox.w,
      y: this.startBox.y - (point[1] - start[0][1]) / r.height * this.startBox.h };
    this.draw();
  }
  up(event, cancelled = false) {
    if (!this.points.has(event.pointerId)) return;
    if (!cancelled && this.points.size === 1 && !this.moved) {
      const point = this.imagePoint(this.local(event)).map(v => Math.round(v * 10) / 10);
      if (point[0] > 0 && point[0] < this.sample.width && point[1] > 0 && point[1] < this.sample.height) this.onTap(point);
    }
    this.points.delete(event.pointerId); this.baseline();
  }
  annotate(value) { this.annotations = value; this.draw(); }
  draw() {
    if (!this.box) return;
    // Only image-dependent geometry is supplied here; visual roles live in styles.css.
    const { box, sample } = this;
    box.x = Math.min(sample.width - box.w / 4, Math.max(-box.w * 0.75, box.x));
    box.y = Math.min(sample.height - box.h / 4, Math.max(-box.h * 0.75, box.y));
    this.svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
    this.overlay.replaceChildren();
    const unit = box.w / this.svg.getBoundingClientRect().width;
    const { a, b, trace = [] } = this.annotations;
    if (trace.length) this.overlay.append(element('polyline', { class: 'trace-line', points: trace.map(p => p.join(',')).join(' ') }));
    for (const point of trace) this.overlay.append(element('circle', { class: 'trace-point', cx: point[0], cy: point[1], r: 3 * unit }));
    for (const [label, point] of [['A', a], ['B', b]]) if (point) {
      const group = element('g', { class: `anchor anchor-${label.toLowerCase()}` });
      group.append(element('circle', { cx: point[0], cy: point[1], r: 15 * unit }));
      const text = element('text', { x: point[0], y: point[1], 'font-size': 14 * unit });
      text.textContent = label; group.append(text); this.overlay.append(group);
    }
  }
}
