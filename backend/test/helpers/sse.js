// Parse the newline-delimited event/data fields emitted by chat's Server-Sent Events route.
export function parseSse(text) {
    const events = [];
    let name = 'message', data = [];
    const dispatch = () => {
        if (data.length) {
            const joined = data.join('\n');
            let value = joined;
            try { value = JSON.parse(joined); } catch { /* non-JSON event data stays text */ }
            events.push({ name, data: value });
        }
        name = 'message'; data = [];
    };
    for (const line of String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
        if (!line) { dispatch(); continue; }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') name = value;
        else if (field === 'data') data.push(value);
    }
    dispatch();
    return events;
}
