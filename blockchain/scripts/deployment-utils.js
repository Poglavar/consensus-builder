const { readFileSync, readdirSync, existsSync } = require('fs');
const path = require('path');

function normalizeChainId(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        return BigInt(Math.trunc(value)).toString();
    }
    const str = String(value).trim();
    if (!str) return null;
    try {
        return BigInt(str).toString();
    } catch (_) {
        if (str.startsWith('0x') || str.startsWith('0X')) {
            try {
                return BigInt(str).toString();
            } catch (_) {
                return str;
            }
        }
        return str;
    }
}

function findDeploymentAddress(contractName, chainId, options = {}) {
    const deploymentsRoot = options.deploymentsRoot || path.resolve(__dirname, '../deployments');

    let directories;
    try {
        directories = readdirSync(deploymentsRoot, { withFileTypes: true });
    } catch (_) {
        return null;
    }

    const targetChainId = normalizeChainId(chainId);

    for (const entry of directories) {
        if (!entry.isDirectory()) continue;
        const dirName = entry.name;
        const chainIdFile = path.join(deploymentsRoot, dirName, '.chainId');
        if (!existsSync(chainIdFile)) continue;

        let deploymentChainId = null;
        try {
            deploymentChainId = normalizeChainId(readFileSync(chainIdFile, 'utf8'));
        } catch (_) {
            deploymentChainId = null;
        }

        if (targetChainId && deploymentChainId && targetChainId !== deploymentChainId) {
            continue;
        }

        const contractJsonPath = path.join(deploymentsRoot, dirName, `${contractName}.json`);
        if (!existsSync(contractJsonPath)) {
            continue;
        }

        try {
            const deployment = JSON.parse(readFileSync(contractJsonPath, 'utf8'));
            if (deployment && deployment.address) {
                return { address: deployment.address, directory: dirName, deployment };
            }
        } catch (_) {
            // Ignore malformed deployment file and continue searching
        }
    }

    return null;
}

function resolveContractAddress(contractName, chainId, { explicitAddress = null, deploymentsRoot } = {}) {
    if (explicitAddress) {
        return { address: explicitAddress, source: 'env' };
    }

    const resolved = findDeploymentAddress(contractName, chainId, { deploymentsRoot });
    if (!resolved) {
        return null;
    }

    return {
        address: resolved.address,
        source: `deployments/${resolved.directory}`,
        deployment: resolved.deployment
    };
}

module.exports = {
    findDeploymentAddress,
    resolveContractAddress
};
