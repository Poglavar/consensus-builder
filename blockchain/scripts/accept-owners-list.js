#!/usr/bin/env node
/**
 * Accept a proposal using an owner-list attestation, creating claim + endorsement attestations on the fly.
 *
 * This script:
 *  - Resolves RPC, EAS, ProposalNFT, ParcelNFT addresses from CLI/env/addresses.json.
 *  - Fetches an owner-list attestation (UID provided).
 *  - Finds a proposal that includes the parcel (optionally specific proposalId).
 *  - For each owner in the owner list, creates a claim attestation (owner signs) and an endorsement attestation (lens signs),
 *    then calls acceptProposal with ownerListUid + UIDs.
 *
 * Requirements:
 *  - OWNER_LIST_UID must be provided via --owner-list-uid or env OWNER_LIST_UID.
 *  - Owner private keys must be supplied; by default OWNER_PK_1, OWNER_PK_2, ... matching order in the owner list.
 *    You can override with --owner-pks '[{"address":"0x...","pk":"0x..."}, ...]'.
 *  - Lens private keys: LENS_1_PK, LENS_2_PK, LENS_3_PK (one is chosen at random) or pass --lens-pk.
 *  - Schema UIDs: OWN_SCHEMA_UID and ENDORSE_SCHEMA_UID in env (or pass --own-schema, --endorse-schema).
 *
 * Usage example:
 *   node scripts/accept-owners-list.js \
 *     --owner-list-uid 0xOwnerListUid... \
 *     --proposal-id 1 \
 *     --own-schema 0xOwnSchemaUid... \
 *     --endorse-schema 0xEndorseSchemaUid...
 *
 * Optional:
 *   --owner-pks '[{"address":"0xabc...","pk":"0xowner1..."},{"address":"0xdef...","pk":"0xowner2..."}]'
 *   --lens-pk 0xlens...
 *   --rpc <RPC_URL> --eas <EAS_ADDRESS> --proposal-nft <ADDR> --parcel-nft <ADDR>
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");
const { JsonRpcProvider, Wallet, Contract, AbiCoder, getAddress, NonceManager } = require("ethers");
const argv = require("minimist")(process.argv.slice(2), {
  string: [
    "rpc",
    "eas",
    "proposal-nft",
    "parcel-nft",
    "owner-list-uid",
    "proposal-id",
    "owner-pks",
    "lens-pk",
    "own-schema",
    "endorse-schema"
  ]
});

function pickRpcUrl() {
  return argv.rpc || process.env.RPC_URL || "http://localhost:8545";
}

function pickAddr(cliKey, envKey, chainId, name) {
  if (argv[cliKey]) return getAddress(argv[cliKey]);
  if (process.env[envKey]) return getAddress(process.env[envKey]);
  const chainEnv = process.env[`${envKey}_${chainId}`];
  if (chainEnv) return getAddress(chainEnv);
  const depAddr = tryDeployment(name, chainId);
  if (depAddr) return depAddr;
  throw new Error(
    `Missing address for ${name}. Provide --${cliKey} or set ${envKey}(/_${chainId}) or deployments/<localhost|chainId>/${name}.json.`
  );
}

function tryDeployment(name, chainId) {
  try {
    const chainDir = chainId === "31337" ? "localhost" : chainId.toString();
    const p = path.join(__dirname, "..", "deployments", chainDir, `${name}.json`);
    const deployed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (deployed && deployed.address) return getAddress(deployed.address);
  } catch (_) {
    // ignore
  }
  return null;
}

function decodeOwnerListData(coder, data) {
  try {
    const [targetChain, targetContract, targetTokenIdStr, owners] = coder.decode(
      ["string", "string", "string", "tuple(string name,address owner,string dptoNumber,uint256 shareBps)[]"],
      data
    );
    return { targetChain, targetContract, targetTokenIdStr, owners };
  } catch (e) {
    const hex = data.startsWith("0x") ? data : "0x" + Buffer.from(data).toString("hex");
    const len = hex.length / 2;
    throw new Error(`Failed to decode owner list data (len=${len} bytes): ${e}`);
  }
}

function pickSchema(cliKey, envKey, legacyKey) {
  const val = argv[cliKey] || process.env[envKey] || (legacyKey ? process.env[legacyKey] : undefined);
  if (!val) throw new Error(`Missing schema UID for ${envKey}${legacyKey ? ` (or ${legacyKey})` : ""}. Provide --${cliKey} or set env.`);
  return val;
}

function pickLensPk() {
  if (argv["lens-pk"]) return argv["lens-pk"];
  const lensPks = [process.env.LENS_1_PK, process.env.LENS_2_PK, process.env.LENS_3_PK].filter(Boolean);
  if (lensPks.length === 0) throw new Error("Missing lens PK. Provide --lens-pk or set LENS_1_PK/LENS_2_PK/LENS_3_PK.");
  const idx = Math.floor(Math.random() * lensPks.length);
  return lensPks[idx];
}

function parseOwnerPks(owners) {
  // CLI override
  if (argv["owner-pks"]) {
    const arr = JSON.parse(argv["owner-pks"]);
    const map = {};
    for (const entry of arr) {
      if (!entry.address || !entry.pk) throw new Error("owner-pks entries need address and pk");
      map[getAddress(entry.address)] = entry.pk;
    }
    return map;
  }

  // Env lookup by matching ACCOUNT_*_ADDRESS -> ACCOUNT_*_PRIVATE_KEY
  const map = {};
  for (const owner of owners) {
    const addr = getAddress(owner.owner);
    const pk = findPkForAddress(addr);
    if (pk) {
      map[addr] = pk;
    }
  }
  return map;
}

function findPkForAddress(addr) {
  const entries = Object.entries(process.env).filter(([k]) => k.startsWith("ACCOUNT_") && k.endsWith("_ADDRESS"));
  for (const [key, val] of entries) {
    try {
      if (getAddress(val) === addr) {
        const prefix = key.replace("_ADDRESS", "");
        const pk = process.env[`${prefix}_PRIVATE_KEY`];
        if (pk) return pk;
      }
    } catch (_) {
      // ignore invalid address
    }
  }
  return null;
}

async function main() {
  const rpcUrl = pickRpcUrl();
  const provider = new JsonRpcProvider(rpcUrl);
  const chainId = (await provider.getNetwork()).chainId.toString();

  const proposalNftAddr = pickAddr("proposal-nft", "PROPOSAL_NFT", chainId, "ProposalNFT");
  const parcelNftAddr = pickAddr("parcel-nft", "PARCEL_NFT", chainId, "ParcelNFT");
  const easAddress = pickAddr("eas", "EAS_ADDRESS", chainId, "EAS");
  const ownerListUid = argv["owner-list-uid"] || process.env.OWNER_LIST_UID;
  if (!ownerListUid) throw new Error("Missing owner list UID. Provide --owner-list-uid or set OWNER_LIST_UID.");

  const ownSchemaUid = pickSchema("own-schema", "OWN_THIS_SCHEMA_UID", "OWN_SCHEMA_UID");
  const endorseSchemaUid = pickSchema("endorse-schema", "ENDORSE_SCHEMA_UID");

  const lensPk = pickLensPk();
  const lens = new Wallet(lensPk, provider);

  console.log("Using addresses:");
  console.log("  RPC:", rpcUrl);
  console.log("  ChainId:", chainId);
  console.log("  ProposalNFT:", proposalNftAddr);
  console.log("  ParcelNFT:", parcelNftAddr);
  console.log("  EAS:", easAddress);
  console.log("  OwnerList UID:", ownerListUid);

  // ABIs
  const proposalAbi = [
    "function getProposalsForParcel(string) view returns (uint256[])",
    "function getProposal(uint256) view returns (string[] parcelIds,bool,bool,string,bool,uint256,uint256,uint256,uint256,uint256)",
    "function acceptProposal(uint256,string,bytes32,bytes32,bytes32)"
  ];
  const parcelAbi = ["function parcelIdForTokenId(uint256) view returns (string)", "function tokenIdForParcelId(string) view returns (uint256)"];
  const easAbi = [
    "function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))",
    "function attest((bytes32 schema, (address recipient, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data, uint256 value) data)) payable returns (bytes32)"
  ];

  const proposal = new Contract(proposalNftAddr, proposalAbi, provider);
  const parcel = new Contract(parcelNftAddr, parcelAbi, provider);
  const eas = new Contract(easAddress, easAbi, provider);

  // Load owner list attestation
  const att = await eas.getAttestation(ownerListUid);
  if (att.attester === "0x0000000000000000000000000000000000000000") throw new Error("Owner list attestation not found");
  const coder = AbiCoder.defaultAbiCoder();
  const { targetChain, targetContract, targetTokenIdStr, owners } = decodeOwnerListData(coder, att.data);
  console.log("Owner list attestation:");
  console.log("  attester:", att.attester);
  console.log("  schema:", att.schema);
  console.log("  recipient:", att.recipient);
  console.log("  refUID:", att.refUID);
  console.log("  expirationTime:", att.expirationTime.toString());
  console.log("  revocationTime:", att.revocationTime.toString());
  console.log("  targetChain:", targetChain);
  console.log("  targetContract:", targetContract);
  console.log("  targetTokenId:", targetTokenIdStr);
  console.log("  owners:", owners);
  if (targetChain !== chainId) throw new Error(`Owner list chain mismatch: ${targetChain} vs ${chainId}`);
  if (getAddress(targetContract) !== getAddress(parcelNftAddr)) throw new Error("Owner list contract mismatch");
  const parcelTokenId = BigInt(targetTokenIdStr);
  const parcelId = await parcel.parcelIdForTokenId(parcelTokenId);

  // pick proposal
  let proposalId = argv["proposal-id"] ? BigInt(argv["proposal-id"]) : null;
  if (proposalId === null) {
    const proposalIds = await proposal.getProposalsForParcel(parcelId);
    if (!proposalIds || proposalIds.length === 0) throw new Error("No proposals found for parcel");
    proposalId = proposalIds[0];
  }

  const ownerPkMap = parseOwnerPks(owners);
  const missing = owners.filter((o) => !ownerPkMap[getAddress(o.owner)]);
  if (missing.length > 0) {
    throw new Error(
      `Missing owner PKs for ${missing.map((m) => m.owner).join(", ")}. Provide OWNER_PK_1.. or --owner-pks.`
    );
  }

  // helper: make claim + endorsement and accept
  async function acceptAsOwner(ownerEntry) {
    const ownerAddr = getAddress(ownerEntry.owner);
    const ownerSigner = new NonceManager(new Wallet(ownerPkMap[ownerAddr], provider));

    // claim
    const claimData = coder.encode(
      ["string", "string", "string", "string"],
      ["I_OWN_THIS", chainId, parcelNftAddr, parcelTokenId.toString()]
    );
    const claimUid = await attest(ownerSigner, {
      schema: ownSchemaUid,
      recipient: ownerAddr,
      expirationTime: 0,
      revocable: true,
      refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
      data: claimData,
      value: 0
    });

    // endorsement
    const lensManaged = new NonceManager(lens);
    const endorseUid = await attest(lensManaged, {
      schema: endorseSchemaUid,
      recipient: ownerAddr,
      expirationTime: 0,
      revocable: true,
      refUID: claimUid,
      data: coder.encode(["bool"], [true]),
      value: 0
    });

    // accept
    const proposalWithSigner = proposal.connect(ownerSigner);
    console.log(`Accepting as owner ${ownerAddr} on proposal ${proposalId} parcel ${parcelId}`);
    console.log("  ownerListUid:", ownerListUid);
    console.log("  claimUid:", claimUid);
    console.log("  endorseUid:", endorseUid);
    const tx = await proposalWithSigner.acceptProposal(
      proposalId,
      parcelId,
      ownerListUid,
      claimUid,
      endorseUid,
      { gasLimit: 3_000_000 }
    );
    console.log("  tx hash:", tx.hash);
    await tx.wait();
  }

  async function attest(signer, { schema, recipient, expirationTime, revocable, refUID, data, value }) {
    const easWithSigner = eas.connect(signer);
    const tx = await easWithSigner.attest({
      schema,
      data: {
        recipient,
        expirationTime,
        revocable,
        refUID,
        data,
        value
      }
    });
    const receipt = await tx.wait();
    // EAS Attested event first log topic: keccak256("Attested(address,address,bytes32,bytes32)")
    // uid is in log data at bytes32
    const log = receipt.logs.find((l) => l.data && l.data.length >= 66);
    const uid = log ? "0x" + log.data.slice(2, 66) : null;
    if (!uid) throw new Error("Failed to parse attestation UID");
    return uid;
  }

  for (const owner of owners) {
    await acceptAsOwner(owner);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

