#!/usr/bin/env node
/**
 * Create an owner-list attestation for a parcel.
 *
 * Usage:
 *   node scripts/create-owner-list.js \
 *     --rpc <RPC_URL> \
 *     --eas <EAS_ADDRESS> \
 *     --schema <OWNER_LIST_SCHEMA_UID> \
 *     --parcel-nft <PARCEL_NFT_ADDRESS> \
 *     --parcel-id "<PARCEL_ID_STRING>" \
 *     --owners '[{"address":"0xabc...","shareBps":7000,"name":"Alice","dptoNumber":""},{"address":"0xdef...","shareBps":3000,"name":"Bob","dptoNumber":""}]' \
 *     # or a single owner shorthand:
 *     --owners 0xabc...   # defaults to 100% share for that address
 *     --pk <LENS_PRIVATE_KEY> \
 *     [--expiration <unix_seconds>] \
 *     [--revocable true|false]
 *
 * Notes:
 * - shareBps should sum to 10_000 (100%). The script warns if it doesn't.
 * - Attester is the provided private key (should be a lens address).
 * - Recipient is set to zero address; refUID is zero; value is zero.
 */

const path = require("path");
const { JsonRpcProvider, Wallet, Contract, AbiCoder, getAddress } = require("ethers");

// Load .env from the blockchain project root even when run from scripts/
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const argv = require("minimist")(process.argv.slice(2), {
  string: ["rpc", "eas", "schema", "parcel-nft", "parcel-id", "owners", "pk", "expiration"],
  boolean: ["revocable"],
  default: { revocable: true, expiration: "0" }
});

function requireArg(name) {
  if (!argv[name]) {
    throw new Error(`Missing required arg --${name}`);
  }
  return argv[name];
}

function parseOwnersInput(input) {
  try {
    const parsed = JSON.parse(input);
    return parsed;
  } catch (_) {
    const trimmed = (input || "").trim();
    const isAddress = /^0x[a-fA-F0-9]{40}$/;
    if (isAddress.test(trimmed)) {
      return [{ address: trimmed, shareBps: 10_000, name: "", dptoNumber: "" }];
    }
    throw new Error(
      'owners must be a JSON array (e.g. \'[{"address":"0x...","shareBps":10000}]\') or a single 0x-address for 100% ownership'
    );
  }
}

async function main() {
  const rpcUrl = pickRpcUrl();
  const schemaUid = pickSchemaUid();
  const parcelId = requireArg("parcel-id");
  const ownersInput = requireArg("owners");
  const pk = pickPk();

  const ownersParsed = parseOwnersInput(ownersInput);
  if (!Array.isArray(ownersParsed) || ownersParsed.length === 0) {
    throw new Error("owners must be a non-empty JSON array");
  }

  let totalBps = 0;
  const owners = ownersParsed.map((o, idx) => {
    if (!o.address || o.shareBps === undefined) {
      throw new Error(`owners[${idx}] must include address and shareBps`);
    }
    const addr = getAddress(o.address);
    const share = Number(o.shareBps);
    if (share <= 0) throw new Error(`owners[${idx}] shareBps must be > 0`);
    totalBps += share;
    return {
      name: o.name || "",
      owner: addr,
      dptoNumber: o.dptoNumber || "",
      shareBps: share
    };
  });
  if (totalBps !== 10_000) {
    console.warn(`Warning: total shareBps = ${totalBps} (expected 10000)`);
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(pk, provider);
  const chainId = (await provider.getNetwork()).chainId.toString();
  const parcelNft = pickParcelNft(chainId);
  const easAddress = pickEasAddress(chainId);

  // Minimal ABIs
  const parcelAbi = ["function tokenIdForParcelId(string) view returns (uint256)"];
  const easAbi = [
    "function attest((bytes32 schema, (address recipient, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data, uint256 value) data)) payable returns (bytes32)"
  ];

  const parcel = new Contract(parcelNft, parcelAbi, provider);
  const tokenId = await parcel.tokenIdForParcelId(parcelId);

  const coder = AbiCoder.defaultAbiCoder();
  // ProposalNFT compares owner list targetContract to Strings.toHexString(address(parcelNFT)),
  // which is lower-case; normalize here to avoid case-sensitive mismatches.
  const targetContract = parcelNft.toLowerCase();
  const data = coder.encode(
    [
      "string", // TARGET_CHAIN
      "string", // TARGET_CONTRACT
      "string", // TARGET_TOKEN_ID
      "tuple(string name,address owner,string dptoNumber,uint256 shareBps)[]"
    ],
    [chainId, targetContract, tokenId.toString(), owners]
  );

  const eas = new Contract(easAddress, easAbi, signer);
  const expirationTime = BigInt(argv.expiration);
  const revocable = argv.revocable !== false;

  const tx = await eas.attest({
    schema: schemaUid,
    data: {
      recipient: "0x0000000000000000000000000000000000000000",
      expirationTime,
      revocable,
      refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
      data,
      value: 0
    }
  });
  console.log("Submitting attestation tx:", tx.hash);
  const receipt = await tx.wait();
  const uid = receipt.logs?.[0]?.data
    ? receipt.logs[0].data.slice(0, 66) // standard EAS Attested uid in first log data
    : undefined;
  console.log("Attestation submitted. UID:", uid || "<parse-from-events>");
}

function pickSchemaUid() {
  if (argv.schema) return argv.schema;
  if (process.env.OWNER_LIST_SCHEMA_UID) return process.env.OWNER_LIST_SCHEMA_UID;
  throw new Error("Missing schema UID. Provide --schema or set OWNER_LIST_SCHEMA_UID in .env");
}

function pickPk() {
  const cliPk = argv.pk;
  if (cliPk) return cliPk;

  const lensPks = [
    process.env.LENS_1_PK,
    process.env.LENS_2_PK,
    process.env.LENS_3_PK
  ].filter(Boolean);

  if (lensPks.length === 0) {
    throw new Error("Missing PK. Provide --pk or set LENS_1_PK/LENS_2_PK/LENS_3_PK in .env");
  }
  const idx = Math.floor(Math.random() * lensPks.length);
  return lensPks[idx];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

function pickRpcUrl() {
  return argv.rpc || process.env.RPC_URL || "http://localhost:8545";
}

function pickEasAddress(chainId) {
  if (argv.eas) return getAddress(argv.eas);
  if (process.env.EAS_ADDRESS) return getAddress(process.env.EAS_ADDRESS);
  const envKey = `EAS_ADDRESS_${chainId}`;
  if (process.env[envKey]) return getAddress(process.env[envKey]);
  throw new Error("Missing EAS address. Provide --eas or set EAS_ADDRESS or EAS_ADDRESS_<chainId> in .env");
}

function pickParcelNft(chainId) {
  if (argv["parcel-nft"]) return getAddress(argv["parcel-nft"]);
  if (process.env.PARCEL_NFT) return getAddress(process.env.PARCEL_NFT);
  const envKey = `PARCEL_NFT_${chainId}`;
  if (process.env[envKey]) return getAddress(process.env[envKey]);

  // Try hardhat-deploy artifacts in ../deployments/<network>/ParcelNFT.json
  const chainToNetwork = { "31337": "localhost", "11155111": "sepolia" };
  const network = chainToNetwork[chainId];
  if (network) {
    try {
      const deployment = require(path.join(__dirname, "..", "deployments", network, "ParcelNFT.json"));
      if (deployment?.address) {
        return getAddress(deployment.address);
      }
    } catch (e) {
      // ignore and continue
    }
  }

  // Try addresses.json
  try {
    const addresses = require("../frontend/contracts/addresses.json");
    const perChain = addresses[chainId];
    if (perChain && perChain.ParcelNFT) {
      return getAddress(perChain.ParcelNFT);
    }
  } catch (e) {
    // ignore
  }
  throw new Error(
    "Missing ParcelNFT address. Provide --parcel-nft or set PARCEL_NFT(_<chainId>) in .env or ensure frontend/contracts/addresses.json has an entry."
  );
}

