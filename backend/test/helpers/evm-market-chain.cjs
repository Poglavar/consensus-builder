// Isolated Anvil + real published Gnosis bytecode. No production configuration or keys are read.
const { spawn } = require('node:child_process');
const net = require('node:net');
const { readFileSync } = require('node:fs');
const { ethers } = require('ethers');
const Markets = require('../../../frontend/js/chain/evm-markets.js');
const artifact = path => JSON.parse(readFileSync(require('node:path').resolve(__dirname, '../../../blockchain', path)));
async function localMarketChain() {
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
    const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--silent'], { stdio: 'ignore' });
    let spawnError; child.on('error', e => { spawnError = e; });
    const url = `http://127.0.0.1:${port}`;
    const provider = new ethers.JsonRpcProvider(url, 31337, { staticNetwork: true, cacheTimeout: -1 });
    provider.pollingInterval = 20;
    async function close() { provider.destroy(); if (child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; } }
    try {
        let ready = false;
        for (let i = 0; i < 50; i++) {
            if (spawnError) throw spawnError;
            try { await provider.send('eth_chainId', []); ready = true; break; } catch (_) { await new Promise(r => setTimeout(r, 100)); }
        }
        if (!ready) throw new Error('Local Anvil did not start');
        const sponsor = await provider.getSigner(0), trader = await provider.getSigner(1), lens = await provider.getSigner(2);
        const deploy = async (data, args = [], library) => {
            let code = data.bytecode.object || data.bytecode;
            if (library) code = code.split('__Fixed192x64Math_______________________').join(library.slice(2).toLowerCase());
            if (!code.startsWith('0x')) code = `0x${code}`;
            const instance = await new ethers.ContractFactory(data.abi, code, sponsor).deploy(...args);
            await instance.waitForDeployment(); return instance;
        };
        const own = (name, args) => deploy(artifact(`forge-out/${name}.sol/${name}.json`), args);
        const gnosis = (pkg, name, library) => deploy(artifact(`solidity-deps/node_modules/@gnosis.pm/${pkg}/build/contracts/${name}.json`), [], library);
        const eas = await own('MockEAS');
        const schema = ethers.id('test-only-agreement-schema');
        const agreement = await own('Agreement', [await eas.getAddress(), schema]);
        const token = await own('TestUSDC');
        const ctf = await gnosis('conditional-tokens-contracts', 'ConditionalTokens');
        const math = await gnosis('conditional-tokens-market-makers', 'Fixed192x64Math');
        const factory = await gnosis('conditional-tokens-market-makers', 'LMSRMarketMakerFactory', await math.getAddress());
        const reporter = await own('AgreementOutcomeReporter', [await agreement.getAddress(), await ctf.getAddress()]);
        const registry = await own('AgreementMarkets', [await agreement.getAddress(), await reporter.getAddress(), await ctf.getAddress(), await factory.getAddress(), await token.getAddress()]);
        const addresses = { Agreement: await agreement.getAddress(), AgreementMarkets: await registry.getAddress(),
            ConditionalTokens: await ctf.getAddress(), AgreementOutcomeReporter: await reporter.getAddress(), MarketCollateral: await token.getAddress() };
        for (const signer of [sponsor, trader]) await (await token.mint(await signer.getAddress(), 100_000_000n)).wait();
        const adapter = signer => Markets.create({ ethers, provider, signer, chainId: '31337', addresses });
        let sequence = 0;
        async function createAgreement(seconds = 3600) {
            const cid = `bafkreiTest${++sequence}`, deadline = (await provider.getBlock('latest')).timestamp + seconds;
            await (await agreement.create(cid, await lens.getAddress(), deadline, false, 0n, await sponsor.getAddress())).wait();
            return { key: await agreement.keyOf(await sponsor.getAddress(), cid), cid, deadline };
        }
        async function execute({ key, cid }) {
            const uid = ethers.id(cid), now = (await provider.getBlock('latest')).timestamp;
            const data = ethers.AbiCoder.defaultAbiCoder().encode(['string', 'address', 'string', 'string', 'uint64'], [cid, await sponsor.getAddress(), 'satisfied', 'local-test', now]);
            await (await eas.setAttestation([uid, schema, now, 0, 0, ethers.ZeroHash, ethers.ZeroAddress, await lens.getAddress(), false, data])).wait();
            await (await agreement.attest(key, uid)).wait(); await (await agreement.execute(key)).wait();
        }
        return { provider, url, addresses, sponsor, trader, agreement, token, ctf, registry, adapter, createAgreement, execute, close };
    } catch (error) { await close(); throw error; }
}

module.exports = { localMarketChain };
