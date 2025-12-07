#!/usr/bin/env node

/**
 * CLI helper to create an attestation against a schema UID.
 *
 * Usage (examples):
 *   node backend/attest.js --schema-uid 0x... [--sender-pk 0x...] [--receiver 0x...] [--network hardhat] [--FIELD value ...]
 *   node backend/attest.js --schema-uid 0x... --TARGET_CHAIN localhost --TARGET_ADDRESS 0xabc...
 *
 * Defaults / fallbacks:
 *   sender_pk   -> env account_1_private_key / ACCOUNT_1_PK / ACCOUNT_1_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY
 *   receiver    -> env account_2 / ACCOUNT_2 / ACCOUNT_2_ADDRESS, else sender address
 *   network     -> cli --network, else env TARGET_NETWORK, else 'hardhat'
 *   schema_uid  -> required (no fallback)
 *   schema fields -> use provided flags matching field names; otherwise auto-generate random values per type
 */

const path = require('path')
const dotenv = require('dotenv')
dotenv.config({ path: path.resolve(__dirname, '.env') })
// Fallback to repo root .env if present
dotenv.config({ path: path.resolve(__dirname, '..', '.env') })
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') })
const crypto = require('crypto')
const { EAS, SchemaEncoder } = require('@ethereum-attestation-service/eas-sdk')
const { ethers } = require('ethers')
const SUPPORTED_NETWORKS = {
  hardhat: { rpcEnv: ['RPC_URL', 'ETHEREUM_RPC_URL'], chainId: '31337' },
  localhost: { rpcEnv: ['RPC_URL', 'ETHEREUM_RPC_URL'], chainId: '31337' },
  anvil: { rpcEnv: ['RPC_URL', 'ETHEREUM_RPC_URL'], chainId: '31337' },
  sepolia: { rpcEnv: ['ETHEREUM_RPC_URL', 'RPC_URL'], chainId: '11155111' },
}

function getRpcUrl(network) {
  const cfg = SUPPORTED_NETWORKS[network]
  if (!cfg) return null
  for (const key of cfg.rpcEnv) {
    if (process.env[key]) return process.env[key]
  }
  return null
}

function getEnvByNetwork(base, chainId) {
  if (chainId && process.env[`${base}_${chainId}`]) return process.env[`${base}_${chainId}`]
  return process.env[base]
}

function getAddresses(network, chainId) {
  const eas = getEnvByNetwork('EAS_ADDRESS', chainId)
  const registry = getEnvByNetwork('SCHEMA_REGISTRY_ADDRESS', chainId)
  return { eas, registry }
}

async function fetchSchemaFromRegistry(registryAddr, schemaUid, provider) {
  if (!registryAddr) return null
  const registry = new ethers.Contract(
    registryAddr,
    ['function getSchema(bytes32 uid) view returns (tuple(bytes32 uid,address resolver,bool revocable,string schema))'],
    provider
  )
  try {
    const record = await registry.getSchema(schemaUid)
    if (!record || record.uid === ethers.ZeroHash) return null
    return record
  } catch (err) {
    console.error(`Failed to fetch schema ${schemaUid} from registry ${registryAddr}:`, err.message || err)
    return null
  }
}


const RESERVED = new Set([
  'schema-uid',
  'schema_uid',
  'sender-pk',
  'sender_pk',
  'receiver',
  'recipient',
  'network',
  'ref-auid',
  'ref_auid',
  'refuid',
])

function firstEnv(...keys) {
  for (const key of keys) {
    if (process.env[key] !== undefined) return process.env[key]
    const upper = key.toUpperCase()
    if (process.env[upper] !== undefined) return process.env[upper]
  }
  return undefined
}

function parseArgs() {
  const argv = process.argv.slice(2)
  const opts = { fields: {} }

  for (let i = 0; i < argv.length; i += 1) {
    let token = argv[i]
    if (!token.startsWith('--')) continue

    token = token.slice(2)
    let value = null

    if (token.includes('=')) {
      const parts = token.split(/=(.+)/)
      token = parts[0]
      value = parts[1]
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1]
      i += 1
    } else {
      value = 'true'
    }

    switch (token) {
      case 'schema-uid':
      case 'schema_uid':
        opts.schemaUid = value
        break
      case 'sender-pk':
      case 'sender_pk':
        opts.senderPk = value
        break
      case 'receiver':
      case 'recipient':
        opts.receiver = value
        break
      case 'network':
        opts.network = value
        break
      case 'ref-auid':
      case 'ref_auid':
      case 'refuid': {
        // If provided without a value, treat as unset (do not auto-fill)
        if (value && value !== 'true') {
          opts.refAuid = value
        }
        break
      }
      default:
        opts.fields[token] = value
    }
  }

  return opts
}

function splitSchemaFields(schema) {
  const parts = []
  let depth = 0
  let current = ''

  for (const ch of schema) {
    if (ch === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim())
      current = ''
      continue
    }
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function parseSchemaFields(schema) {
  return splitSchemaFields(schema).map((entry, idx) => {
    const match = entry.match(/^(.*\S)\s+([A-Za-z0-9_]+)$/)
    if (!match) {
      return { type: entry.trim(), name: `field${idx}` }
    }
    return { type: match[1].trim(), name: match[2].trim() }
  })
}

function randomHex(bytes) {
  return `0x${crypto.randomBytes(bytes).toString('hex')}`
}

function randomValueForType(type) {
  const isArray = type.endsWith('[]')
  const base = isArray ? type.slice(0, -2) : type
  const lower = base.toLowerCase()

  const pickScalar = () => {
    if (lower === 'string') return `auto-${randomHex(3)}`
    if (lower === 'bool') return Math.random() < 0.5
    if (lower === 'address') return ethers.Wallet.createRandom().address
    if (lower.startsWith('uint') || lower.startsWith('int')) return BigInt(Math.floor(Math.random() * 1000) + 1)
    if (lower.startsWith('bytes32')) return randomHex(32)
    if (lower.startsWith('bytes')) {
      const size = Number.parseInt(lower.replace('bytes', ''), 10) || 4
      const capped = Number.isFinite(size) ? Math.max(1, Math.min(size, 32)) : 4
      return randomHex(capped)
    }
    if (lower.startsWith('tuple(')) {
      const inner = base.slice(6, -1)
      const innerFields = parseSchemaFields(inner)
      return innerFields.map((f) => ({
        name: f.name,
        type: f.type,
        value: randomValueForType(f.type),
      }))
    }
    return `auto-${randomHex(3)}`
  }

  const scalar = pickScalar()

  if (isArray) {
    // Provide a single element; empty array is also accepted if encoding fails
    if (Array.isArray(scalar)) {
      return [{ value: scalar }]
    }
    return [scalar]
  }

  return scalar
}

function coerceValue(type, raw) {
  if (raw === undefined || raw === null) return undefined

  const isArray = type.endsWith('[]')
  const base = isArray ? type.slice(0, -2) : type
  const lower = base.toLowerCase()

  const parseOne = (val) => {
    if (lower === 'bool') return ['true', '1', 'yes', 'on'].includes(String(val).toLowerCase())
    if (lower.startsWith('uint') || lower.startsWith('int')) return BigInt(val)
    if (lower.startsWith('bytes')) return val.startsWith('0x') ? val : `0x${val}`
    return val
  }

  if (isArray) {
    const parts = Array.isArray(raw) ? raw : String(raw).split(',').map((s) => s.trim()).filter(Boolean)
    return parts.map(parseOne)
  }
  return parseOne(raw)
}

function buildDataItems(schemaString, overrides) {
  const fields = parseSchemaFields(schemaString)
  return fields.map((field) => {
    const override =
      overrides[field.name] ?? overrides[field.name.toLowerCase()] ?? overrides[field.name.toUpperCase()]
    const value =
      override !== undefined ? coerceValue(field.type, override) : randomValueForType(field.type)
    return { name: field.name, type: field.type, value }
  })
}

async function main() {
  const args = parseArgs()

  const schemaUid = args.schemaUid
  if (!schemaUid) {
    console.error('Error: --schema-uid is required')
    process.exit(1)
  }

  const network = args.network || process.env.TARGET_NETWORK || 'hardhat'
  const networkCfg = SUPPORTED_NETWORKS[network]
  if (!networkCfg) {
    console.error(`Error: unsupported network "${network}". Supported: ${Object.keys(SUPPORTED_NETWORKS).join(', ')}`)
    process.exit(1)
  }
  const rpcUrl = getRpcUrl(network)
  if (!rpcUrl) {
    console.error(`Error: missing RPC URL for network "${network}". Set ${networkCfg.rpcEnv.join(' or ')}.`)
    process.exit(1)
  }

  const senderPk =
    args.senderPk ||
    firstEnv('account_1_private_key', 'ACCOUNT_1_PK', 'ACCOUNT_1_PRIVATE_KEY', 'DEPLOYER_PRIVATE_KEY')

  if (!senderPk) {
    console.error('Error: sender private key missing. Pass --sender-pk or set account_1_private_key/ACCOUNT_1_PK.')
    process.exit(1)
  }

  const receiver =
    args.receiver ||
    firstEnv('account_2', 'ACCOUNT_2', 'ACCOUNT_2_ADDRESS') ||
    null

  const refUID = args.refAuid
  if (refUID && !/^0x[0-9a-fA-F]{64}$/.test(refUID)) {
    console.error('Error: --ref-auid must be a 32-byte hex string (0x...)')
    process.exit(1)
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const networkInfo = await provider.getNetwork()
  const chainIdStr = networkInfo.chainId.toString()
  const signer = new ethers.Wallet(senderPk, provider)

  const recipient = receiver || signer.address

  const { eas: easAddress, registry: schemaRegistryAddress } = getAddresses(network, chainIdStr)
  if (!easAddress) {
    console.error(
      `Error: Missing EAS contract address for network "${network}". Set EAS_ADDRESS or EAS_ADDRESS_${chainIdStr} in .env.`
    )
    process.exit(1)
  }

  if (!schemaRegistryAddress) {
    console.error(
      `Error: Missing Schema Registry address for network "${network}". Set SCHEMA_REGISTRY_ADDRESS or SCHEMA_REGISTRY_ADDRESS_${chainIdStr} in .env.`
    )
    process.exit(1)
  }

  console.log(`Network: ${network} (chainId ${chainIdStr})`)
  console.log(`EAS: ${easAddress}`)
  console.log(`Schema registry: ${schemaRegistryAddress}`)
  console.log(`Signer: ${signer.address}`)
  console.log(`Recipient: ${recipient}`)

  const schemaRecord = await fetchSchemaFromRegistry(schemaRegistryAddress, schemaUid, provider)
  if (!schemaRecord || !schemaRecord.schema) {
    console.error(`Schema ${schemaUid} not found on ${network} (registry ${schemaRegistryAddress})`)
    process.exit(1)
  }

  const dataItems = buildDataItems(schemaRecord.schema, args.fields)
  const schemaEncoder = new SchemaEncoder(schemaRecord.schema)
  let encodedData
  try {
    encodedData = schemaEncoder.encodeData(dataItems)
  } catch (err) {
    console.error('Failed to encode data for schema:', schemaRecord.schema)
    console.error(err)
    process.exit(1)
  }

  const eas = new EAS(easAddress).connect(signer)

  console.log('Attesting with fields:')
  for (const item of dataItems) {
    console.log(`  ${item.name} (${item.type}):`, item.value)
  }

  const tx = await eas.attest(
    {
      schema: schemaUid,
      data: {
        recipient,
        expirationTime: 0,
        revocable: true,
        refUID: refUID || ethers.ZeroHash,
        data: encodedData,
      },
    },
    { gasLimit: 1_000_000 }
  )

  const submittedHash = tx?.hash || tx?.tx?.hash || tx?.transactionHash || '<unavailable>'
  console.log(`Transaction submitted: ${submittedHash}`)

  const attestationUid = await tx.wait()
  console.log(`Attestation UID: ${attestationUid}`)
  console.log(`Explorer (if available): https://${network}.easscan.org/attestation/view/${attestationUid}`)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})

