// Browser-wallet bridge for lens-model v2 consent on proposal_nft: an attested owner's "Say yes"
// (accept_with_attestations) and the permissionless verdict settlement (settle_with_verdict). Every
// PDA, instruction byte and account decode comes from SolanaAcceptanceClient; this file only owns
// finding the member's attestation, wallet signing, preflight and the transaction status states.
(function attachSolanaAcceptanceBridge(root) {
    'use strict';
    if (!root) return;

    function log(message, extra) {
        const line = `[${new Date().toISOString()}] [SolanaAcceptanceBridge] ${message}`;
        if (extra === undefined) console.info(line); else console.info(line, extra);
    }

    async function dependencies() {
        if (!root.solanaWeb3?.Transaction && typeof root.ensureWalletVendors === 'function') await root.ensureWalletVendors();
        if (!root.solanaWeb3?.Transaction) throw new Error('Solana web3.js is unavailable');
        if (!root.SolanaAcceptanceClient) throw new Error('Acceptance client is unavailable');
        if (!root.SolanaChainDataLoader?.getConnection) throw new Error('Solana connection is unavailable');
        return root.SolanaAcceptanceClient;
    }

    function codedError(message, code, extra = {}) {
        const error = new Error(message);
        error.code = code;
        Object.assign(error, extra);
        return error;
    }

    function explorerTx(signature, cluster) {
        const suffix = cluster && cluster !== 'mainnet-beta' ? `?cluster=${encodeURIComponent(cluster)}` : '';
        return `https://explorer.solana.com/tx/${signature}${suffix}`;
    }

    function walletContext() {
        const manager = root.solanaWalletManager;
        const provider = manager?.getProvider?.();
        if (!provider?.publicKey || typeof provider.signTransaction !== 'function') {
            throw codedError('Connect a Solana wallet first', 'WALLET_NOT_CONNECTED');
        }
        return { provider, wallet: provider.publicKey, cluster: manager?.getCluster?.() || 'devnet' };
    }

    async function programIds() {
        const client = root.SolanaAcceptanceClient;
        const bridge = root.SolanaProposalChainBridge;
        const proposalProgram = (bridge && await bridge.resolveProposalProgramId()) || client.constants.PROPOSAL_NFT_PROGRAM_ID;
        const parcelProgram = (bridge && await bridge.resolveParcelProgramId()) || client.constants.PARCEL_NFT_PROGRAM_ID;
        return { proposalProgram, parcelProgram };
    }

    function emitStatus(options, state, extra = {}) {
        if (typeof options?.onStatus === 'function') options.onStatus({ state, ...extra });
    }

    // preparing -> awaiting_signature -> submitted -> confirmed, as in market-bridge / pledge-bridge.
    async function send(connection, provider, wallet, cluster, instructions, options = {}) {
        emitStatus(options, 'preparing');
        const latest = await connection.getLatestBlockhash('confirmed');
        const transaction = new root.solanaWeb3.Transaction({ feePayer: wallet, recentBlockhash: latest.blockhash });
        instructions.forEach(instruction => transaction.add(instruction));
        const simulation = await connection.simulateTransaction(transaction, { sigVerify: false });
        if (simulation?.value?.err) {
            throw codedError('Transaction simulation failed', 'SIMULATION_FAILED', { logs: simulation.value.logs || [], simulationError: simulation.value.err });
        }
        emitStatus(options, 'awaiting_signature');
        const signed = await provider.signTransaction(transaction);
        const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        const explorerUrl = explorerTx(signature, cluster);
        emitStatus(options, 'submitted', { signature, explorerUrl });
        let confirmation;
        try {
            confirmation = await connection.confirmTransaction({ ...latest, signature }, 'confirmed');
        } catch (cause) {
            throw codedError('Transaction was submitted but confirmation timed out', 'CONFIRMATION_UNKNOWN', { cause, transactionHash: signature, explorerUrl });
        }
        if (confirmation?.value?.err) throw codedError('Transaction failed during confirmation', 'CONFIRMATION_FAILED', { transactionHash: signature, explorerUrl });
        emitStatus(options, 'confirmed', { signature, explorerUrl });
        return { transactionHash: signature, explorerUrl };
    }

    async function readProposal(client, connection, proposal) {
        const parsed = await client.fetchProposal(connection, proposal);
        if (!parsed) throw codedError('Proposal account not found or not a proposal_nft v2 account', 'PROPOSAL_NOT_FOUND');
        return parsed;
    }

    // Per-parcel consent state for the Details card: tally (accepted/required/member), whether the
    // parcel is complete, and this wallet's own acceptance record when one exists.
    async function readAcceptanceState({ proposal, parcelIds = [], owner = null } = {}) {
        const client = await dependencies();
        const cluster = root.solanaWalletManager?.getCluster?.() || 'devnet';
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const { proposalProgram } = await programIds();
        const parsed = await readProposal(client, connection, proposal);
        const parcels = {};
        await Promise.all(parcelIds.map(async parcelId => {
            const [tally, record] = await Promise.all([
                client.fetchConsentTally(connection, { proposal, parcelId, programId: proposalProgram }),
                owner ? client.fetchAcceptanceRecord(connection, { proposal, parcelId, owner, programId: proposalProgram }) : null
            ]);
            parcels[parcelId] = { tally, record, complete: parsed.acceptedParcels.includes(parcelId) };
        }));
        return { proposal: parsed, parcels, cluster };
    }

    // The member's ownership attestation for this wallet+parcel, asked from every lens member that
    // publishes a service URL. When a tally already exists only its member's attestation can count.
    async function findOwnershipAttestation({ members, parcelUid, owner, requiredMember = null }) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const asked = [];
        for (const member of members) {
            if (requiredMember && member.key !== requiredMember) continue;
            if (!member.serviceUrl) { asked.push({ member: member.key, outcome: 'no_service_url' }); continue; }
            const response = await root.LensServiceClient.fetchAttestations({ serviceUrl: member.serviceUrl, filter: { parcelUid, owner, kind: 'ownership' } });
            if (!Array.isArray(response.attestations)) {
                asked.push({ member: member.key, outcome: response.outcome.message || `HTTP ${response.status}` });
                continue;
            }
            const match = response.attestations.find(att => att.authority === member.key
                && att.parcelUid === parcelUid && att.owner === owner
                && !(typeof att.expiry === 'number' && att.expiry > 0 && att.expiry <= nowSeconds));
            asked.push({ member: member.key, outcome: match ? 'found' : 'none' });
            if (match) return { member, attestation: match, asked };
        }
        return { member: null, attestation: null, asked };
    }

    // The credential the attestation names on chain is what the program compares against. When the
    // member's status publishes its credential name, the derived PDA must agree with it.
    async function resolveCredential(client, member, onChain) {
        if (!member.serviceUrl) return { credential: onChain.credential, derived: false };
        const status = await root.LensServiceClient.fetchStatus({ serviceUrl: member.serviceUrl });
        const name = status.outcome.kind === 'ok' && status.body && typeof status.body.credentialName === 'string' ? status.body.credentialName : null;
        if (!name) {
            log(`member ${member.key}: no credentialName in /lens/status; using the credential the attestation names on chain`);
            return { credential: onChain.credential, derived: false };
        }
        const derived = client.deriveCredentialPda(member.key, name).toBase58();
        if (derived !== onChain.credential) {
            throw codedError(`Attestation credential ${onChain.credential} is not the member's credential ${derived}`, 'CREDENTIAL_MISMATCH');
        }
        return { credential: derived, derived: true };
    }

    // Say yes: find the ownership attestation, check it against the proposal, sign
    // accept_with_attestations, then read the tally back. `members` are the lens entries with
    // directory data ({ key, serviceUrl }); `payout` is an optional base58 key.
    async function sayYes({ proposal, parcelId, members = [], payout = null, ...options } = {}) {
        const client = await dependencies();
        const { provider, wallet, cluster } = walletContext();
        const owner = wallet.toBase58();
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const { proposalProgram, parcelProgram } = await programIds();
        if (payout && !root.LensCore.isBase58Pubkey(payout)) throw codedError('Payout must be a base58 Solana address', 'BAD_PAYOUT');

        emitStatus(options, 'finding_attestation');
        const parsed = await readProposal(client, connection, proposal);
        const [existingTally, existingRecord] = await Promise.all([
            client.fetchConsentTally(connection, { proposal, parcelId, programId: proposalProgram }),
            client.fetchAcceptanceRecord(connection, { proposal, parcelId, owner, programId: proposalProgram })
        ]);
        if (existingRecord) throw codedError('This wallet has already said yes for this parcel', 'ALREADY_ACCEPTED', { record: existingRecord });
        const lensMembers = members.filter(member => parsed.lens.includes(member.key));
        const found = await findOwnershipAttestation({ members: lensMembers, parcelUid: parcelId, owner, requiredMember: existingTally ? existingTally.member : null });
        log(`ownership lookup for ${parcelId} / ${owner}`, found.asked);
        if (!found.attestation) {
            throw codedError('No lens member has attested this wallet as an owner of this parcel', 'NO_ATTESTATION', { asked: found.asked, requiredMember: existingTally ? existingTally.member : null });
        }

        const onChain = await client.fetchLensAttestation(connection, 'ownership', found.attestation.address);
        if (!onChain) throw codedError(`Attestation ${found.attestation.address} is not on chain`, 'ATTESTATION_NOT_ON_CHAIN');
        if (onChain.authority !== found.member.key) throw codedError('Attestation was not signed by the member that served it', 'WRONG_AUTHORITY');
        const problem = client.checkOwnershipForAccept({ attestation: onChain, fields: onChain.fields, proposal: parsed, parcelId, owner });
        if (problem) throw codedError(`Acceptance would be rejected: ${problem}`, 'PRECHECK_FAILED', { reason: problem });
        if (existingTally && existingTally.required !== onChain.fields.ownerCount) {
            throw codedError(`The member now counts ${onChain.fields.ownerCount} owners but this parcel's tally requires ${existingTally.required}`, 'PRECHECK_FAILED', { reason: 'owner_count_changed' });
        }
        const { credential } = await resolveCredential(client, found.member, onChain);

        const built = client.buildAcceptWithAttestationsIx({
            proposal, parcelId, ownership: onChain.address, ownershipCredential: credential,
            owner: wallet, payer: wallet, payout: payout || null, programId: proposalProgram, parcelProgramId: parcelProgram
        });
        const sent = await send(connection, provider, wallet, cluster, [built.instruction], options);
        const [tally, after] = await Promise.all([
            client.fetchConsentTally(connection, { proposal, parcelId, programId: proposalProgram }),
            client.fetchProposal(connection, proposal)
        ]);
        log(`accepted ${parcelId} on ${proposal}`, { signature: sent.transactionHash, tally });
        return {
            ...sent,
            member: found.member.key,
            attestation: onChain.address,
            tally,
            proposal: after,
            parcelComplete: !!after && after.acceptedParcels.includes(parcelId),
            executed: !!after && after.statusCode === client.constants.STATUS_EXECUTED
        };
    }

    // Permissionless: anyone may submit a lens member's ProposalVerdict-v1 attestation.
    async function submitVerdict({ proposal, verdictAttestation, ...options } = {}) {
        const client = await dependencies();
        const { provider, wallet, cluster } = walletContext();
        if (!root.LensCore.isBase58Pubkey(String(verdictAttestation || '').trim())) throw codedError('Verdict attestation must be a base58 address', 'BAD_ATTESTATION');
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const { proposalProgram } = await programIds();
        const parsed = await readProposal(client, connection, proposal);
        const onChain = await client.fetchLensAttestation(connection, 'verdict', verdictAttestation.trim());
        if (!onChain) throw codedError(`Attestation ${verdictAttestation} is not on chain`, 'ATTESTATION_NOT_ON_CHAIN');
        const verdictRecords = await client.fetchVerdictRecords(connection, { proposal, programId: proposalProgram });
        const problem = client.checkVerdictForSettle({ attestation: onChain, fields: onChain.fields, proposal: parsed, proposalAddress: parsed.address, verdictRecords });
        if (problem) throw codedError(`Settlement would be rejected: ${problem}`, 'PRECHECK_FAILED', { reason: problem });
        // The program checks the credential's authority against the attestation signer, so the
        // credential the attestation itself names is the one to pass.
        // The submitter signs and is writable: it pays rent for the VerdictRecord PDA.
        const instruction = client.buildSettleWithVerdictIx({
            proposal, verdict: onChain.address, verdictCredential: onChain.credential, submitter: wallet, programId: proposalProgram
        });
        const verdictRecord = client.getVerdictRecordPda(proposal, onChain.address, proposalProgram)[0].toBase58();
        const sent = await send(connection, provider, wallet, cluster, [instruction], options);
        const [after, record] = await Promise.all([
            client.fetchProposal(connection, proposal),
            client.fetchVerdictRecord(connection, { proposal, verdictAttestation: onChain.address, programId: proposalProgram })
        ]);
        log(`settled ${proposal} with verdict ${onChain.fields.verdict}; verdict record ${verdictRecord}`, {
            signature: sent.transactionHash, status: after && after.status, recordOnChain: !!record
        });
        return { ...sent, verdict: onChain.fields.verdict, member: onChain.authority, proposal: after, verdictRecord, record };
    }

    // distribute_funds v2: remaining accounts are built from the tallies and acceptance records.
    async function distributeFunds({ proposal, ...options } = {}) {
        const client = await dependencies();
        const { provider, wallet, cluster } = walletContext();
        const connection = root.SolanaChainDataLoader.getConnection(cluster);
        const { proposalProgram } = await programIds();
        const parsed = await readProposal(client, connection, proposal);
        const [tallies, records] = await Promise.all([
            client.fetchConsentTallies(connection, { proposal, programId: proposalProgram }),
            client.fetchAcceptanceRecords(connection, { proposal, programId: proposalProgram })
        ]);
        const remaining = client.planDistribution({ proposal: parsed, tallies, records });
        const instruction = client.buildDistributeFundsIx({ proposal, remaining, programId: proposalProgram });
        return { ...(await send(connection, provider, wallet, cluster, [instruction], options)), chainId: `solana-${cluster}`, cluster, contractAddress: proposalProgram };
    }

    root.SolanaAcceptanceBridge = { readAcceptanceState, findOwnershipAttestation, sayYes, submitVerdict, distributeFunds };
})(typeof window !== 'undefined' ? window : null);
