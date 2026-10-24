// Native database readers report the same domain failures for HTTP and non-HTTP consumers.
export function databaseSourceError(status, payload) {
    return Object.assign(new Error(payload.error), { status, payload, databaseSourceFailure: true });
}
export const isDatabaseSourceError = error => error?.databaseSourceFailure === true;
