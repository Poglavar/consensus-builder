#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const { EAS, SchemaEncoder } = require('@ethereum-attestation-service/eas-sdk');
const { resolveContractAddress } = require('./deploymentUtils');

// Load .env from blockchain/.env first, then repo root
const envPath = fs.existsSync(path.join(__dirname, '../.env'))
  ? path.join(__dirname, '../.env')
  : path.join(__dirname, '../../.env');
require('dotenv').config({ path: envPath });

const DEFAULT_NETWORK = 'hardhat';
const SUPPORTED_NETWORKS = {
  hardhat: { rpcEnv: 'RPC_URL' },
  anvil: { rpcEnv: 'RPC_URL' },
  sepolia: { rpcEnv: 'ETHEREUM_RPC_URL' },
  mainnet: { rpcEnv: 'ETHEREUM_RPC_URL' },
  'ethereum-mainnet': { rpcEnv: 'ETHEREUM_RPC_URL' },
  base: { rpcEnv: 'ETHEREUM_RPC_URL' },
  'base-sepolia': { rpcEnv: 'ETHEREUM_RPC_URL' },
};

const ACCOUNT_KEYS = [
  { addressKey: 'ACCOUNT_1_ADDRESS', privateKeyKey: 'ACCOUNT_1_PRIVATE_KEY' },
  { addressKey: 'ACCOUNT_2_ADDRESS', privateKeyKey: 'ACCOUNT_2_PRIVATE_KEY' },
  { addressKey: 'ACCOUNT_3_ADDRESS', privateKeyKey: 'ACCOUNT_3_PRIVATE_KEY' },
  { addressKey: 'ACCOUNT_4_ADDRESS', privateKeyKey: 'ACCOUNT_4_PRIVATE_KEY' },
  { addressKey: 'ACCOUNT_5_ADDRESS', privateKeyKey: 'ACCOUNT_5_PRIVATE_KEY' },
  { addressKey: 'ACCOUNT_6_ADDRESS', privateKeyKey: 'ACCOUNT_6_PRIVATE_KEY' },
];

const LENS_ACCOUNT_KEYS = [
  {
    addressKey: 'LENS_1',
    privateKeyKey: 'LENS_1_PK',
    altAddressKeys: ['lens_1'],
    altPrivateKeyKeys: ['lens_1_pk'],
  },
  {
    addressKey: 'LENS_2',
    privateKeyKey: 'LENS_2_PK',
    altAddressKeys: ['lens_2'],
    altPrivateKeyKeys: ['lens_2_pk'],
  },
  {
    addressKey: 'LENS_3',
    privateKeyKey: 'LENS_3_PK',
    altAddressKeys: ['lens_3'],
    altPrivateKeyKeys: ['lens_3_pk'],
  },
];

const parcelAbi = [
  'function totalSupply() view returns (uint256)',
  'function tokenByIndex(uint256 index) view returns (uint256)',
  'function parcelIdForTokenId(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

const schemaRegistryAbi = [
  'function getSchema(bytes32 uid) view returns (tuple(bytes32 uid, address resolver, bool revocable, string schema))',
];

const easReaderAbi = [
  'function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))',
];

const easErrorInterface = new ethers.Interface([
  'error AccessDenied()',
  'error AlreadyRevoked()',
  'error AttestationsDisabled()',
  'error InvalidAttestation()',
  'error InvalidExpirationTime()',
  'error InvalidLength()',
  'error InvalidSchema()',
  'error InvalidSignature()',
  'error InvalidVerifier()',
  'error NotFound()',
  'error NotPayable()',
  'error NotRevocable()',
  'error ResolverFailed(bytes)',
  'error SchemaNotFound()',
  'error WrongSchema()',
]);

const coder = ethers.AbiCoder.defaultAbiCoder();

function parseNetwork(argv) {
  let network = DEFAULT_NETWORK;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--network=')) {
      network = arg.split('=')[1] || network;
    } else if (arg === '--network' && argv[i + 1]) {
      network = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--')) {
      const candidate = arg.slice(2);
      if (SUPPORTED_NETWORKS[candidate]) {
        network = candidate;
      }
    }
  }
  if (!SUPPORTED_NETWORKS[network]) {
    const supported = Object.keys(SUPPORTED_NETWORKS).join(', ');
    throw new Error(`Unsupported network "${network}". Supported: ${supported}`);
  }
  return network;
}

function parseParcelId(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--parcel-id=')) {
      const value = arg.split('=')[1];
      if (value) return value;
    }
    if (arg === '--parcel-id' && argv[i + 1]) {
      return argv[i + 1];
    }
  }
  return null;
}

function resolveRpcUrl(network) {
  const rpcEnv = SUPPORTED_NETWORKS[network]?.rpcEnv;
  if (rpcEnv === 'RPC_URL') {
    return process.env.RPC_URL || process.env.ETHEREUM_RPC_URL || null;
  }
  if (rpcEnv === 'ETHEREUM_RPC_URL') {
    return process.env.ETHEREUM_RPC_URL || process.env.RPC_URL || null;
  }
  return process.env.RPC_URL || process.env.ETHEREUM_RPC_URL || null;
}

function readEnvWithAliases(keys = []) {
  for (const key of keys) {
    if (!key) continue;
    if (process.env[key] !== undefined) return process.env[key];
    const upper = key.toUpperCase();
    if (process.env[upper] !== undefined) return process.env[upper];
  }
  return undefined;
}

function loadAccounts(pairs, label) {
  const accounts = [];
  for (const { addressKey, privateKeyKey, altAddressKeys = [], altPrivateKeyKeys = [] } of pairs) {
    const pk = readEnvWithAliases([privateKeyKey, ...altPrivateKeyKeys]);
    const envAddress = readEnvWithAliases([addressKey, ...altAddressKeys]);
    if (!pk) {
      continue;
    }
    let wallet;
    try {
      wallet = new ethers.Wallet(pk);
    } catch (err) {
      throw new Error(`Invalid private key for ${privateKeyKey}: ${err.message}`);
    }
    const address = envAddress || wallet.address;
    accounts.push({ address, privateKey: pk, addressKey, privateKeyKey });
  }
  if (accounts.length === 0) {
    throw new Error(`No ${label} accounts found. Populate env vars for them.`);
  }
  return accounts;
}

async function loadParcels(contract, totalSupply) {
  const total = Number(totalSupply);
  if (!Number.isSafeInteger(total)) {
    throw new Error('Parcel totalSupply is too large for safe iteration.');
  }
  const parcels = [];
  for (let i = 0; i < total; i++) {
    const tokenId = await contract.tokenByIndex(i);
    const parcelId = await contract.parcelIdForTokenId(tokenId);
    parcels.push({
      tokenId: tokenId.toString(),
      parcelId,
    });
  }
  return parcels;
}

function distributeParcels(parcels, claimants) {
  const assignments = [];
  parcels.forEach((parcel, idx) => {
    const claimant = claimants[idx % claimants.length];
    assignments.push({ parcel, claimant, overlap: false });
  });
  return assignments;
}

function buildOverlapAssignments(parcels, claimants, existingAssignments) {
  if (claimants.length < 2 || parcels.length === 0) return [];
  const overlapCount = Math.max(1, Math.floor(parcels.length * 0.1));
  const shuffled = [...parcels].sort(() => Math.random() - 0.5);
  const extras = [];
  for (let i = 0; i < overlapCount; i++) {
    const target = shuffled[i];
    const alreadyClaimants = existingAssignments
      .filter(a => a.parcel.parcelId === target.parcelId)
      .map(a => a.claimant.address.toLowerCase());
    const options = claimants.filter(c => !alreadyClaimants.includes(c.address.toLowerCase()));
    if (options.length === 0) {
      continue;
    }
    const claimant = options[Math.floor(Math.random() * options.length)];
    extras.push({ parcel: target, claimant, overlap: true });
  }
  return extras;
}

function buildOwnershipData(parcelId, chainId, parcelContractAddress, tokenId) {
  return coder.encode(
    ['string', 'string', 'string', 'string'],
    [parcelId, chainId.toString(), parcelContractAddress, tokenId.toString()]
  );
}

async function sendOwnershipAttestation({
  easSdk,
  schemaUid,
  schemaString,
  parcel,
  chainId,
  parcelContractAddress,
  recipient,
}) {
  const encoder = new SchemaEncoder(schemaString);
  const encoded = encoder.encodeData([
    { name: 'I_OWN_THIS', type: 'string', value: parcel.parcelId },
    { name: 'TARGET_CHAIN', type: 'string', value: String(chainId) },
    { name: 'TARGET_ADDRESS', type: 'string', value: parcelContractAddress },
    { name: 'TARGET_ID', type: 'string', value: parcel.tokenId },
  ]);

  const tx = await easSdk.attest(
    {
      schema: schemaUid,
      data: {
        recipient,
        expirationTime: 0,
        revocable: true,
        refUID: ethers.ZeroHash,
        data: encoded,
        value: 0,
      },
    },
    { gasLimit: 1_000_000 }
  );
  const uid = await tx.wait();
  return { uid, txHash: tx.hash || tx?.tx?.hash || tx?.transactionHash || null };
}

function pickClaimsToEndorse(claims) {
  return claims.filter(() => Math.random() < 0.5);
}

function buildTruthData() {
  return coder.encode(['bool'], [true]);
}

async function sendTruthAttestation({ easSdk, schemaUid, schemaString, refUid, recipient, revocable = true }) {
  const encoder = new SchemaEncoder(schemaString);
  const encoded = encoder.encodeData([{ name: 'THIS_ATTESTATION_IS_TRUE', type: 'bool', value: true }]);
  const safeRefUid =
    refUid && typeof refUid === 'string' && refUid.startsWith('0x') && refUid.length === 66
      ? refUid
      : ethers.ZeroHash;
  const tx = await easSdk.attest(
    {
      schema: schemaUid,
      data: {
        recipient,
        expirationTime: 0,
        revocable,
        refUID: safeRefUid,
        data: encoded,
      },
    },
    { gasLimit: 500_000 }
  );
  const uid = await tx.wait();
  return { uid, txHash: tx.hash || tx?.tx?.hash || tx?.transactionHash || null };
}

async function main() {
  try {
    const argv = process.argv.slice(2);
    const networkName = parseNetwork(argv);
    const parcelIdFilter = parseParcelId(argv);
    const rpcUrl = resolveRpcUrl(networkName);
    if (!rpcUrl) {
      throw new Error('Missing RPC_URL or ETHEREUM_RPC_URL in environment.');
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const network = await provider.getNetwork();
    console.log(`Network: ${networkName} (chainId: ${network.chainId})`);

    const chainIdStr = network.chainId.toString();

    const parcelAddressInfo = resolveContractAddress('ParcelNFT', network.chainId, {
      explicitAddress: process.env.PARCEL_NFT_ADDRESS,
    });
    if (!parcelAddressInfo) {
      throw new Error('ParcelNFT address not found. Set PARCEL_NFT_ADDRESS or add a deployment file.');
    }
    console.log(`ParcelNFT: ${parcelAddressInfo.address} (${parcelAddressInfo.source || 'resolved'})`);

    const easAddress =
      process.env[`EAS_ADDRESS_${chainIdStr}`] ||
      process.env[`EAS_CONTRACT_ADDRESS_${chainIdStr}`] ||
      process.env.EAS_ADDRESS ||
      process.env.EAS_CONTRACT_ADDRESS;
    if (!easAddress) {
      throw new Error('Missing EAS_ADDRESS (or EAS_CONTRACT_ADDRESS) in environment.');
    }
    console.log(`EAS: ${easAddress}`);
    const schemaRegistryAddress =
      process.env[`SCHEMA_REGISTRY_ADDRESS_${chainIdStr}`] ||
      process.env[`SCHEMA_REGISTRY_${chainIdStr}`] ||
      process.env.SCHEMA_REGISTRY_ADDRESS ||
      process.env.SCHEMA_REGISTRY;
    if (schemaRegistryAddress) {
      console.log(`Schema registry: ${schemaRegistryAddress}`);
    } else {
      console.log('Schema registry: <none set>');
    }

    const parcelContract = new ethers.Contract(parcelAddressInfo.address, parcelAbi, provider);
    const easReaderContract = new ethers.Contract(easAddress, easReaderAbi, provider);
    const schemaRegistry = schemaRegistryAddress
      ? new ethers.Contract(schemaRegistryAddress, schemaRegistryAbi, provider)
      : null;

    const totalSupply = await parcelContract.totalSupply();
    if (totalSupply === 0n) {
      console.log('No parcels minted on this network.');
      return;
    }
    console.log(`Total parcels: ${totalSupply.toString()}`);

    const parcels = await loadParcels(parcelContract, totalSupply);
    console.log(`Fetched ${parcels.length} parcel identifiers.`);

    let parcelsToProcess = parcels;
    let parcelFilterIndex = -1;
    if (parcelIdFilter) {
      parcelFilterIndex = parcels.findIndex(p => p.parcelId === parcelIdFilter);
      if (parcelFilterIndex === -1) {
        console.error(`Parcel id ${parcelIdFilter} not found among minted parcels.`);
        return;
      }
      parcelsToProcess = [parcels[parcelFilterIndex]];
      console.log(
        `Filtering to parcelId ${parcelIdFilter} (token index ${parcelFilterIndex}); will create one ownership attestation.`
      );
    }

    const claimants = loadAccounts(ACCOUNT_KEYS, 'owner');
    claimants.forEach(acc => {
      console.log(`${acc.addressKey}: ${acc.address}`);
    });

    let baseAssignments;
    if (parcelIdFilter) {
      const claimant = claimants[parcelFilterIndex % claimants.length];
      baseAssignments = [{ parcel: parcelsToProcess[0], claimant, overlap: false }];
      console.log(
        `Single parcel mode: ${parcelIdFilter} assigned to ${claimant.addressKey || claimant.address} (${claimant.address}).`
      );
    } else {
      baseAssignments = distributeParcels(parcelsToProcess, claimants);
    }

    const overlapAssignments = parcelIdFilter
      ? []
      : buildOverlapAssignments(parcelsToProcess, claimants, baseAssignments);
    const allAssignments = [...baseAssignments, ...overlapAssignments];
    if (parcelIdFilter) {
      console.log(`Prepared ${allAssignments.length} ownership attestation for parcel ${parcelIdFilter}.`);
    } else {
      console.log(
        `Prepared ${allAssignments.length} ownership attestations (${overlapAssignments.length} overlap assignments).`
      );
    }

    const ownershipSchemaUid = process.env.OWN_THIS_SCHEMA_UID;
    const truthSchemaUid = process.env.ENDORSE_SCHEMA_UID;
    if (!ownershipSchemaUid || !truthSchemaUid) {
      throw new Error('Missing OWN_THIS_SCHEMA_UID and/or ENDORSE_SCHEMA_UID in environment.');
    }
    let ownershipSchemaString = null;
    let truthSchemaString = 'bool THIS_ATTESTATION_IS_TRUE';
    let truthRevocable = true;
    console.log(`Using schemas -> I_OWN_THIS: ${ownershipSchemaUid}, ENDORSE/TRUTH: ${truthSchemaUid}`);
    if (schemaRegistry) {
      const ownershipRecord = await schemaRegistry.getSchema(ownershipSchemaUid).catch(() => null);
      const truthRecord = await schemaRegistry.getSchema(truthSchemaUid).catch(() => null);
      const hasOwnership = ownershipRecord && ownershipRecord.uid !== ethers.ZeroHash;
      const hasTruth = truthRecord && truthRecord.uid !== ethers.ZeroHash;
      console.log(
        `Schema registry check: I_OWN_THIS ${hasOwnership ? 'found' : 'missing'}; TRUTH ${hasTruth ? 'found' : 'missing'}`
      );
      if (hasOwnership && ownershipRecord?.schema) {
        console.log(`  I_OWN_THIS schema string: ${ownershipRecord.schema}`);
        console.log(`  I_OWN_THIS resolver: ${ownershipRecord.resolver} revocable: ${ownershipRecord.revocable}`);
        ownershipSchemaString = ownershipRecord.schema;
      }
      if (hasTruth && truthRecord?.schema) {
        console.log(`  TRUTH schema string: ${truthRecord.schema}`);
        console.log(`  TRUTH resolver: ${truthRecord.resolver} revocable: ${truthRecord.revocable}`);
        truthSchemaString = truthRecord.schema || truthSchemaString;
        truthRevocable = truthRecord?.revocable !== false;
      }
    }
    if (!ownershipSchemaString) {
      throw new Error('Ownership schema string not found on-chain; cannot encode payload.');
    }

    const ownershipResults = [];
    for (const assignment of allAssignments) {
      const wallet = new ethers.Wallet(assignment.claimant.privateKey, provider);
      const signer = new ethers.NonceManager(wallet);
      const easSdk = new EAS(easAddress);
      easSdk.connect(signer);
      const claimantLabel = assignment.claimant?.addressKey ? `${assignment.claimant.addressKey} ` : '';
      try {
        const { uid, txHash } = await sendOwnershipAttestation({
          easSdk,
          schemaUid: ownershipSchemaUid,
          schemaString: ownershipSchemaString,
          parcel: assignment.parcel,
          chainId: network.chainId,
          parcelContractAddress: parcelAddressInfo.address,
          recipient: wallet.address,
        });
        ownershipResults.push({
          ...assignment,
          uid,
          txHash,
          attester: wallet.address,
        });
        console.log(
          `✅ Ownership attestation for parcel ${assignment.parcel.parcelId} by ${claimantLabel}${wallet.address} (tx ${txHash})`
        );
        // Confirm the attestation exists on-chain and log
        try {
          const att = await easReaderContract.getAttestation(uid);
          const exists = att && att.uid && att.uid !== ethers.ZeroHash;
          console.log(
            exists
              ? `   ↳ confirmed on-chain attestation uid: ${att.uid}`
              : `   ↳ attestation uid ${uid} not found when re-fetching`
          );
        } catch (err) {
          console.error(`   ↳ failed to fetch attestation ${uid}: ${err.shortMessage || err.message}`);
        }
      } catch (err) {
        console.error(
          `❌ Failed ownership attestation for parcel ${assignment.parcel.parcelId} by ${claimantLabel}${wallet.address}: ${err.shortMessage || err.message
          }`
        );
        if (err?.data) {
          console.error(`   revert data: ${err.data}`);
          try {
            const parsed = easErrorInterface.parseError(err.data);
            console.error(`   decoded revert: ${parsed?.name} ${parsed?.args ? JSON.stringify(parsed.args, null, 2) : ''}`);
          } catch (_) {
            // ignore decode errors
          }
        }
        if (err?.reason) {
          console.error(`   reason: ${err.reason}`);
        }
        if (err?.code) {
          console.error(`   code: ${err.code}`);
        }
      }
    }

    if (ownershipResults.length === 0) {
      console.log('No ownership attestations were created; stopping before endorsements.');
      return;
    }

    const lensAccounts = loadAccounts(LENS_ACCOUNT_KEYS, 'lens');
    lensAccounts.forEach((acc, idx) => {
      console.log(`LENS_${idx + 1}: ${acc.address}`);
    });
    // Prepare nonce-managed signers per lens address
    const lensSignerMap = new Map();
    lensAccounts.forEach(acc => {
      const wallet = new ethers.Wallet(acc.privateKey, provider);
      lensSignerMap.set(acc.address.toLowerCase(), new ethers.NonceManager(wallet));
    });

    const toEndorse = parcelIdFilter
      ? ownershipResults
      : pickClaimsToEndorse(ownershipResults);
    if (parcelIdFilter) {
      console.log(
        `Prepared ${toEndorse.length} endorsement${toEndorse.length === 1 ? '' : 's'} for parcel ${parcelIdFilter}.`
      );
    } else {
      console.log(`Prepared ${toEndorse.length} endorsements out of ${ownershipResults.length} claims (~50%).`);
    }

    const endorsementResults = [];
    for (const claim of toEndorse) {
      // Verify the referenced ownership attestation exists before attempting truth/endorse attestation
      try {
        const att = await easReaderContract.getAttestation(claim.uid);
        if (!att || att.uid === ethers.ZeroHash) {
          console.error(`⚠️  Skipping endorsement; ownership attestation not found for UID ${claim.uid}`);
          continue;
        }
      } catch (err) {
        console.error(`⚠️  Skipping endorsement; could not fetch attestation ${claim.uid}: ${err.shortMessage || err.message}`);
        continue;
      }

      const lens = lensAccounts[Math.floor(Math.random() * lensAccounts.length)];
      const lensSigner = lensSignerMap.get(lens.address.toLowerCase());
      if (!lensSigner) {
        console.error(`   ❌ Lens signer not found for ${lens.address}`);
        continue;
      }
      const lensEasSdk = new EAS(easAddress);
      lensEasSdk.connect(lensSigner);
      try {
        const { uid, txHash } = await sendTruthAttestation({
          easSdk: lensEasSdk,
          schemaUid: truthSchemaUid,
          schemaString: truthSchemaString,
          refUid: claim.uid,
          recipient: claim.attester,
          revocable: truthRevocable,
        });
        endorsementResults.push({
          claimParcelId: claim.parcel.parcelId,
          claimUid: claim.uid,
          lens: lens.address,
          uid,
          txHash,
        });
        console.log(
          `✅ Endorsed claim ${claim.uid} for parcel ${claim.parcel.parcelId} by lens ${lens.address} (tx ${txHash})`
        );
      } catch (err) {
        console.error(
          `❌ Failed endorsement for claim ${claim.uid} by lens ${lens.address}: ${err.shortMessage || err.message
          }`
        );
        if (err?.data) console.error(`   revert data: ${err.data}`);
        if (err?.reason) console.error(`   reason: ${err.reason}`);
        if (err?.code) console.error(`   code: ${err.code}`);
        try {
          const att = await easReaderContract.getAttestation(claim.uid);
          const exists = att && att.uid && att.uid !== ethers.ZeroHash;
          console.error(
            exists
              ? `   ownership attestation ${claim.uid} exists (schema ${att.schema})`
              : `   ownership attestation ${claim.uid} not found on-chain`
          );
        } catch (fetchErr) {
          console.error(
            `   failed to re-fetch ownership attestation ${claim.uid}: ${fetchErr.shortMessage || fetchErr.message}`
          );
        }
        const truthData = buildTruthData();
        try {
          const decoded = coder.decode(['bool'], truthData);
          console.error('   decoded data:', JSON.stringify({ truth: decoded[0] }, null, 2));
        } catch (_) {
          // ignore decode errors
        }
        console.error(
          '   request:',
          JSON.stringify(
            {
              schema: truthSchemaUid,
              data: {
                recipient: claim.attester,
                expirationTime: 0,
                revocable: truthRevocable,
                refUID: claim.uid,
                data: truthData,
                value: 0,
              },
            },
            null,
            2
          )
        );
      }
    }

    if (parcelIdFilter) {
      const claimantSummary = ownershipResults
        .map(r => `${r.claimant?.addressKey || 'owner'} (${r.attester})`)
        .join(', ');
      console.log(`Parcel ${parcelIdFilter} ownership attestations created by: ${claimantSummary}`);
      if (endorsementResults.length > 0) {
        const lensSummary = endorsementResults
          .map(r => `${r.lens} (claim ${r.claimUid})`)
          .join(', ');
        console.log(`Lens confirmations: ${lensSummary}`);
      } else {
        console.log('No lens confirmations sent for filtered parcel.');
      }
    }

    console.log('---------------------------');
    console.log('Ownership attestations:', ownershipResults.length);
    console.log('Endorsements sent:', endorsementResults.length);
    console.log('Done.');
  } catch (error) {
    console.error('attest-ownership failed:', error.message || error);
    process.exit(1);
  }
}

main();

