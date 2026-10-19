// Retries a lens-member step whose prerequisite (the directory API, Solana RPC, Postgres) may not be up yet, for
// instance right after a server reboot, waiting longer after each failure. Every failure is logged with the next
// attempt time, so a member waiting on a dependency is visible rather than silently idle; giveUpAfterMs bounds the
// wait and then throws, so a prerequisite that never comes back still fails loudly.

export async function retryWithBackoff(failureLabel, fn, {
    firstDelayMs = 15000,
    maxDelayMs = 300000,
    giveUpAfterMs = Infinity,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = () => Date.now(),
    log = message => console.error(`[${new Date().toISOString()}] [lens-member] ${message}`)
} = {}) {
    const started = now();
    for (let attempt = 1, delay = firstDelayMs; ; attempt++, delay = Math.min(delay * 2, maxDelayMs)) {
        try {
            return await fn(attempt);
        } catch (error) {
            if (now() - started + delay > giveUpAfterMs) {
                throw new Error(`${failureLabel}: gave up after ${attempt} attempt(s) over ${Math.round((now() - started) / 1000)}s: ${error.message}`);
            }
            log(`${failureLabel} (attempt ${attempt}): ${error.message}; retrying in ${Math.round(delay / 1000)}s`);
            await wait(delay);
        }
    }
}
