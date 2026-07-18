// Timestamped console logging for the corridor generator scripts.
export function log(...args) {
    console.log(new Date().toISOString(), ...args);
}

export function fail(...args) {
    console.error(new Date().toISOString(), 'ERROR', ...args);
    process.exit(1);
}
