// Dijkstra least-cost path over the cost grid (8-neighbor). Cost of a move is
// the euclidean step distance times the mean of the two cells' effective
// costs (base cost × penalty layer). Returns the path as an array of cell
// indices, or null if unreachable.
export function leastCostPath(grid, baseCost, penalty, startIdx, endIdx) {
    const n = grid.size;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const visited = new Uint8Array(n);
    const heap = new MinHeap(n);
    dist[startIdx] = 0;
    heap.push(startIdx, 0);
    const { cols, cell } = grid;
    const neighborOffsets = [-1, 1, -cols, cols, -cols - 1, -cols + 1, cols - 1, cols + 1];
    const neighborDist = [cell, cell, cell, cell, cell * Math.SQRT2, cell * Math.SQRT2, cell * Math.SQRT2, cell * Math.SQRT2];

    while (heap.length > 0) {
        const u = heap.pop();
        if (u === endIdx) break;
        if (visited[u]) continue;
        visited[u] = 1;
        const uc = baseCost[u] * penalty[u];
        const uCol = u % cols;
        for (let k = 0; k < 8; k++) {
            const v = u + neighborOffsets[k];
            if (v < 0 || v >= n || visited[v]) continue;
            // Prevent wrap-around at grid edges.
            const vCol = v % cols;
            if (Math.abs(vCol - uCol) > 1) continue;
            const vc = baseCost[v] * penalty[v];
            if (!isFinite(vc)) continue;
            const nd = dist[u] + neighborDist[k] * (uc + vc) / 2;
            if (nd < dist[v]) {
                dist[v] = nd;
                prev[v] = u;
                heap.push(v, nd);
            }
        }
    }
    if (!isFinite(dist[endIdx])) return null;
    const path = [];
    for (let u = endIdx; u !== -1; u = prev[u]) path.push(u);
    path.reverse();
    return { path, cost: dist[endIdx] };
}

// Binary min-heap of (cellIdx, key) pairs; stale entries are skipped via the
// visited check in the caller (lazy deletion).
class MinHeap {
    constructor(capacityHint) {
        this.idx = new Int32Array(capacityHint * 4);
        this.key = new Float64Array(capacityHint * 4);
        this.length = 0;
    }
    push(i, k) {
        if (this.length === this.idx.length) {
            const ni = new Int32Array(this.idx.length * 2); ni.set(this.idx); this.idx = ni;
            const nk = new Float64Array(this.key.length * 2); nk.set(this.key); this.key = nk;
        }
        let c = this.length++;
        this.idx[c] = i; this.key[c] = k;
        while (c > 0) {
            const p = (c - 1) >> 1;
            if (this.key[p] <= this.key[c]) break;
            this.swap(p, c); c = p;
        }
    }
    pop() {
        const top = this.idx[0];
        this.length--;
        if (this.length > 0) {
            this.idx[0] = this.idx[this.length]; this.key[0] = this.key[this.length];
            let c = 0;
            for (;;) {
                const l = 2 * c + 1, r = l + 1;
                let m = c;
                if (l < this.length && this.key[l] < this.key[m]) m = l;
                if (r < this.length && this.key[r] < this.key[m]) m = r;
                if (m === c) break;
                this.swap(m, c); c = m;
            }
        }
        return top;
    }
    swap(a, b) {
        const ti = this.idx[a]; this.idx[a] = this.idx[b]; this.idx[b] = ti;
        const tk = this.key[a]; this.key[a] = this.key[b]; this.key[b] = tk;
    }
}
