// FileDownload.save is the app's one download: it clicks a named link and releases the object URL
// only after the browser has had time to start reading it.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const FileDownload = require('../../frontend/js/ui/file-download.js');

function browser() {
    const events = [], timers = [];
    const win = {
        Blob,
        URL: { createObjectURL: blob => { events.push(['create', blob]); return 'blob:1'; }, revokeObjectURL: url => events.push(['revoke', url]) },
        setTimeout: (callback, ms) => timers.push({ callback, ms }),
        document: { body: { appendChild: link => events.push(['attach', link.download]) },
            createElement: () => ({ click() { events.push(['click', this.download, this.href]); }, remove() { events.push(['detach']); } }) }
    };
    return { win, events, timers };
}

describe('FileDownload', () => {
    it('clicks a named link and releases the URL only after a delay', async () => {
        const { win, events, timers } = browser();
        expect(FileDownload.save(win, '{"a":1}', 'x.json', 'application/json')).toBe('x.json');
        expect(events.map(event => event[0])).toEqual(['create', 'attach', 'click', 'detach']);
        expect(events[2]).toEqual(['click', 'x.json', 'blob:1']);
        expect(await events[0][1].text()).toBe('{"a":1}');
        expect(events[0][1].type).toBe('application/json');
        expect(timers).toHaveLength(1); expect(timers[0].ms).toBeGreaterThanOrEqual(1000);
        timers[0].callback();
        expect(events.at(-1)).toEqual(['revoke', 'blob:1']);
    });
    it('passes a Blob through as it is', () => {
        const { win, events } = browser(); const blob = new Blob(['x'], { type: 'text/csv' });
        FileDownload.save(win, blob, 'x.csv');
        expect(events[0][1]).toBe(blob);
    });
    it('names files after a title', () => {
        expect(FileDownload.fileStem('Riverside Blocks č')).toBe('riverside-blocks-c');
        expect(FileDownload.fileStem('—', 'plan')).toBe('plan');
        expect(FileDownload.fileStem('x'.repeat(80))).toHaveLength(60);
    });
});
