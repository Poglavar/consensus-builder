export const MAX_ACCOUNTS_PER_RPC = 100;

export function accountsPerRequest(env = process.env) {
    const raw = env.SOLANA_RPC_MAX_ACCOUNTS;
    if (raw === undefined || String(raw).trim() === '') return MAX_ACCOUNTS_PER_RPC;

    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ACCOUNTS_PER_RPC) {
        throw new Error(`SOLANA_RPC_MAX_ACCOUNTS must be an integer from 1 to ${MAX_ACCOUNTS_PER_RPC}; got ${JSON.stringify(raw)}`);
    }
    return value;
}

export async function getMultipleAccountsBatched(connection, addresses, {
    commitment = 'confirmed',
    batchSize = accountsPerRequest()
} = {}) {
    if (!Array.isArray(addresses)) throw new TypeError('addresses must be an array');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_ACCOUNTS_PER_RPC) {
        throw new Error(`batchSize must be an integer from 1 to ${MAX_ACCOUNTS_PER_RPC}`);
    }

    const infos = [];
    for (let index = 0; index < addresses.length; index += batchSize) {
        const batch = addresses.slice(index, index + batchSize);
        const batchInfos = await connection.getMultipleAccountsInfo(batch, commitment);
        if (!Array.isArray(batchInfos) || batchInfos.length !== batch.length) {
            throw new Error(`getMultipleAccountsInfo returned ${Array.isArray(batchInfos) ? batchInfos.length : 'no'} results for a batch of ${batch.length} accounts`);
        }
        infos.push(...batchInfos);
    }
    return infos;
}
