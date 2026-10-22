// Typed error for the reference lens member: carries the HTTP status and a stable machine code so
// the server can answer precisely while everything else still fails loudly as a plain Error.
// `details` are extra answer fields (an agreement decision that cannot be issued carries its tally).

export class LensError extends Error {
    constructor(status, code, message, details = null) {
        super(message);
        this.name = 'LensError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

export function lensLog(message) {
    console.log(`[${new Date().toISOString()}] [lens-member] ${message}`);
}
