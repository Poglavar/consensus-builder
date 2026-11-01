// Stream named chat events with unbuffered headers and bounded heartbeat lifetime.
export function openSse(res) {
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event, data) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const timer = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n'); }, 15_000); timer.unref();
    const close = () => { clearInterval(timer); if (!res.writableEnded && !res.destroyed) res.end(); };
    res.once('close', () => clearInterval(timer));
    return { send, close };
}
