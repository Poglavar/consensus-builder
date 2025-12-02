import { spawn } from "child_process";
import { ethers } from "ethers";

const TARGET_ADDRESS = "0xfcf94dd41b2b5d6c887a30273f995d01baca1a45";
const AMOUNT_ETH = "99.0";
const AMOUNT_WEI = ethers.parseEther(AMOUNT_ETH);
const RPC_URL = "http://127.0.0.1:8545";

/**
 * Waits for the Hardhat node to be ready
 */
async function waitForNode(maxRetries = 30, delay = 1000): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      await provider.getBlockNumber();
      return true;
    } catch (error) {
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  return false;
}

/**
 * Funds the target account
 */
async function fundAccount(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const funderPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const funder = new ethers.Wallet(funderPrivateKey, provider);

  console.log(`💰 Funding account ${TARGET_ADDRESS} with ${AMOUNT_ETH} ETH...`);

  const currentBalance = await provider.getBalance(TARGET_ADDRESS);
  console.log(`   Current balance: ${ethers.formatEther(currentBalance)} ETH`);

  const tx = await funder.sendTransaction({
    to: TARGET_ADDRESS,
    value: AMOUNT_WEI,
  });

  console.log(`   Transaction: ${tx.hash}`);
  await tx.wait();

  const newBalance = await provider.getBalance(TARGET_ADDRESS);
  console.log(`   New balance: ${ethers.formatEther(newBalance)} ETH`);
  console.log("✅ Account funded successfully!");
}

/**
 * Main function to start the Hardhat node and fund the account
 */
async function main() {
  console.log("🚀 Starting Hardhat node...");

  // Start Hardhat node
  const nodeProcess = spawn("npx", ["hardhat", "node", "--network", "hardhat", "--no-deploy"], {
    stdio: "inherit",
    shell: true,
  });

  // Wait for node to be ready
  console.log("⏳ Waiting for Hardhat node to be ready...");
  const nodeReady = await waitForNode();

  if (!nodeReady) {
    console.error("❌ Failed to start Hardhat node");
    nodeProcess.kill();
    process.exit(1);
  }

  console.log("✅ Hardhat node is ready!");

  // Fund the account
  try {
    await fundAccount();
  } catch (error) {
    console.error("❌ Failed to fund account:", error);
    nodeProcess.kill();
    process.exit(1);
  }

  console.log("\n📝 Hardhat node is running with funded account");
  console.log("🛑 Press Ctrl+C to stop the node\n");

  // Handle cleanup on exit
  process.on("SIGINT", () => {
    console.log("\n🛑 Stopping Hardhat node...");
    nodeProcess.kill();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    nodeProcess.kill();
    process.exit(0);
  });

  // Keep the process alive
  nodeProcess.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`❌ Hardhat node exited with code ${code}`);
      process.exit(code);
    }
  });
}

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});








