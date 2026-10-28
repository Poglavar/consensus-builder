export function pinningError(code, message, status, extra = {}) {
    return Object.assign(new Error(message), { code, status, ...extra });
}
