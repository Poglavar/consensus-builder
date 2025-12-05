import * as dotenv from "dotenv";
dotenv.config();
import { spawn } from "child_process";
import { config } from "hardhat";

/**
 * Runs the hardhat deploy command with the deployer private key from .env
 */
async function main() {
  const networkIndex = process.argv.indexOf("--network");
  const networkName = networkIndex !== -1 ? process.argv[networkIndex + 1] : config.defaultNetwork;

  // For local networks, just run deploy directly
  if (networkName === "localhost" || networkName === "hardhat") {
    const hardhat = spawn("hardhat", ["deploy", ...process.argv.slice(2)], {
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

  const hardhat = spawn("hardhat", ["deploy", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });

  hardhat.on("exit", code => {
    process.exit(code || 0);
  });
}

main().catch(console.error);
