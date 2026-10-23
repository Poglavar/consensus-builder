// Normalize a caller-supplied record label without consulting app city aliases or configuration.
export function normalizeCityCode(code) {
    const raw = (code || '').toString().trim().toLowerCase();
    return raw || null;
}
