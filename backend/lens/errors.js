// Typed error for the reference lens member: carries the HTTP status and a stable machine code so
// the server can answer precisely while everything else still fails loudly as a plain Error.

export class LensError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'LensError';
        this.status = status;
        this.code = code;
    }
}

export function lensLog(message) {
    console.log(`[${new Date().toISOString()}] [lens-member] ${message}`);
}
