import * as dotenv from "dotenv";
dotenv.config();
import { spawn } from "child_process";
import { config } from "hardhat";
import readline from "readline";
import { getAddress } from "ethers";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { updateDotenv } = require("./update-dotenv");

/**
 * Runs the hardhat deploy command with the deployer private key from .env
 */
async function main() {
  const rawArgs = process.argv.slice(2);
  const { easAddressArg, schemaRegistryArg, passthroughArgs } = stripAddressArgs(rawArgs);
  const networkName = resolveNetworkName(passthroughArgs, config.defaultNetwork);
  const easAddress = await resolveEasAddress(easAddressArg);
  const schemaRegistryAddress = await resolveSchemaRegistryAddress(schemaRegistryArg);

  // Always pass a fresh EAS address to the deploy scripts to avoid stale .env values.
  process.env.RUNTIME_EAS_ADDRESS = easAddress;
  process.env.RUNTIME_SCHEMA_REGISTRY_ADDRESS = schemaRegistryAddress;

  // Persist to blockchain/.env for local chain (31337) so downstream scripts pick up fresh values.
  persistLocalEnvAddresses(easAddress, schemaRegistryAddress);

  // For local networks, just run deploy directly
  if (networkName === "localhost" || networkName === "hardhat") {
    const hardhat = spawn("hardhat", ["deploy", ...passthroughArgs], {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });

    hardhat.on("exit", code => {
      process.exit(code || 0);
    });
    return;
  }

  // For non-local networks, use DEPLOYER_PRIVATE_KEY from .env
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;

  if (!privateKey) {
    console.log("🚫️ DEPLOYER_PRIVATE_KEY not found in .env");
    console.log("   Add your private key to blockchain/.env:");
    console.log("   DEPLOYER_PRIVATE_KEY=0x...");
    process.exit(1);
  }

  // Pass the private key to hardhat via environment variable
  process.env.__RUNTIME_DEPLOYER_PRIVATE_KEY = privateKey;

  console.log(`🚀 Deploying to ${networkName}...`);

  const hardhat = spawn("hardhat", ["deploy", ...passthroughArgs], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });

  hardhat.on("exit", code => {
    process.exit(code || 0);
  });
}

main().catch(console.error);

function stripAddressArgs(args: string[]): {
  easAddressArg?: string;
  schemaRegistryArg?: string;
  passthroughArgs: string[];
} {
  const passthroughArgs: string[] = [];
  let easAddressArg: string | undefined;
  let schemaRegistryArg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--eas" || arg === "--eas-address" || arg === "-e") {
      easAddressArg = args[i + 1];
      i++;
      continue;
    }

    if (arg.startsWith("--eas=") || arg.startsWith("--eas-address=") || arg.startsWith("-e=")) {
      easAddressArg = arg.split("=", 2)[1];
      continue;
    }

    if (arg === "--schema-registry" || arg === "--registry" || arg === "-r") {
      schemaRegistryArg = args[i + 1];
      i++;
      continue;
    }

    if (
      arg.startsWith("--schema-registry=") ||
      arg.startsWith("--registry=") ||
      arg.startsWith("-r=")
    ) {
      schemaRegistryArg = arg.split("=", 2)[1];
      continue;
    }

    passthroughArgs.push(arg);
  }

  return { easAddressArg, schemaRegistryArg, passthroughArgs };
}

function resolveNetworkName(args: string[], fallback: string): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--network" || arg === "-n") {
      return args[i + 1] ?? fallback;
    }
    if (arg.startsWith("--network=") || arg.startsWith("-n=")) {
      const [, value] = arg.split("=", 2);
      return value || fallback;
    }
  }

  return fallback;
}

async function resolveEasAddress(cliAddress?: string): Promise<string> {
  if (cliAddress) {
    return normalizeEasAddress(cliAddress);
  }

  if (!process.stdin.isTTY) {
    const envAddress = process.env.RUNTIME_EAS_ADDRESS;
    if (envAddress) {
      return normalizeEasAddress(envAddress);
    }
    throw new Error("No TTY available. Provide --eas <address> or set RUNTIME_EAS_ADDRESS for CI runs.");
  }

  const prompted = await promptForInput("Enter the EAS contract address for this deployment: ");
  return normalizeEasAddress(prompted);
}

function normalizeEasAddress(raw?: string): string {
  if (!raw) {
    throw new Error("EAS contract address is required for deployment.");
  }

  try {
    return getAddress(raw);
  } catch (error) {
    throw new Error(`Invalid EAS address "${raw}". Provide a valid checksummed address.`);
  }
}

async function resolveSchemaRegistryAddress(cliAddress?: string): Promise<string> {
  if (cliAddress) {
    return normalizeSchemaRegistryAddress(cliAddress);
  }

  if (!process.stdin.isTTY) {
    const envAddress = process.env.RUNTIME_SCHEMA_REGISTRY_ADDRESS;
    if (envAddress) {
      return normalizeSchemaRegistryAddress(envAddress);
    }
    throw new Error(
      "No TTY available. Provide --schema-registry <address> or set RUNTIME_SCHEMA_REGISTRY_ADDRESS for CI runs.",
    );
  }

  const prompted = await promptForInput(
    "Enter the Schema Registry contract address for this deployment: ",
  );
  return normalizeSchemaRegistryAddress(prompted);
}

function normalizeSchemaRegistryAddress(raw?: string): string {
  if (!raw) {
    throw new Error("Schema Registry address is required for deployment.");
  }

  try {
    return getAddress(raw);
  } catch (error) {
    throw new Error(`Invalid Schema Registry address "${raw}". Provide a valid checksummed address.`);
  }
}

function promptForInput(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function persistLocalEnvAddresses(easAddress: string, schemaRegistryAddress: string): void {
  const envPath = path.resolve(__dirname, "../.env");
  const chainSuffix = "31337";

  updateDotenv(envPath, `EAS_ADDRESS_${chainSuffix}`, easAddress);
  updateDotenv(envPath, `SCHEMA_REGISTRY_ADDRESS_${chainSuffix}`, schemaRegistryAddress);
}
