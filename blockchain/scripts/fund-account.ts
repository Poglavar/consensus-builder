import { ethers } from "ethers";

/**
 * Funds a specific account with ETH from the default Hardhat account
 * This script should be run after starting a local Hardhat node
 */
async function main() {
    const TARGET_ADDRESS = "0xfcf94dd41b2b5d6c887a30273f995d01baca1a45";
    const AMOUNT_ETH = "99.0";
    const AMOUNT_WEI = ethers.parseEther(AMOUNT_ETH);
    const RPC_URL = process.env.RPC_URL;

    // Connect to local Hardhat node
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // Use the first Hardhat account (account 0) as the funder
    // This is the default Hardhat account with 10000 ETH
    const funderPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const funder = new ethers.Wallet(funderPrivateKey, provider);

    console.log(`Funding account ${TARGET_ADDRESS} with ${AMOUNT_ETH} ETH...`);
    console.log(`Funder address: ${await funder.getAddress()}`);

    // Check current balance
    const currentBalance = await provider.getBalance(TARGET_ADDRESS);
    console.log(`Current balance: ${ethers.formatEther(currentBalance)} ETH`);

    // Send the transaction
    const tx = await funder.sendTransaction({
        to: TARGET_ADDRESS,
        value: AMOUNT_WEI,
    });

    console.log(`Transaction sent: ${tx.hash}`);
    console.log("Waiting for confirmation...");

    await tx.wait();

    // Check new balance
    const newBalance = await provider.getBalance(TARGET_ADDRESS);
    console.log(`New balance: ${ethers.formatEther(newBalance)} ETH`);
    console.log("✅ Account funded successfully!");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

