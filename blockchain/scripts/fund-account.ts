import { ethers } from "ethers";

/**
 * Funds multiple accounts with ETH from the default Hardhat account
 * This script should be run after starting a local Hardhat node
 * 
 * Loads accounts from environment variables:
 * - ACCOUNT_0_ADDRESS through ACCOUNT_5_ADDRESS
 * - Or uses TARGET_ADDRESSES env var (comma-separated)
 * - Or uses TARGET_ADDRESS env var (single address, for backward compatibility)
 */
async function main() {
    const AMOUNT_ETH = process.env.FUND_AMOUNT_ETH || "99.0";
    const AMOUNT_WEI = ethers.parseEther(AMOUNT_ETH);
    const RPC_URL = process.env.RPC_URL;

    if (!RPC_URL) {
        throw new Error("RPC_URL must be set in environment");
    }

    // Connect to local Hardhat node
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // Use the first Hardhat account (account 0) as the funder
    // This is the default Hardhat account with 10000 ETH
    const funderPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const funder = new ethers.Wallet(funderPrivateKey, provider);

    // Load target addresses from environment
    const targetAddresses: string[] = [];

    // Load from ACCOUNT_0_ADDRESS through ACCOUNT_5_ADDRESS
    for (let i = 0; i <= 5; i++) {
        const address = process.env[`ACCOUNT_${i}_ADDRESS`];
        if (address) {
            targetAddresses.push(address);
        }
    }

    if (targetAddresses.length === 0) {
        throw new Error(
            "No target addresses found. Set one of:\n" +
            "  - TARGET_ADDRESSES (comma-separated addresses)\n" +
            "  - TARGET_ADDRESS (single address)\n" +
            "  - ACCOUNT_0_ADDRESS through ACCOUNT_5_ADDRESS"
        );
    }

    console.log(`\n💰 Funding ${targetAddresses.length} account(s) with ${AMOUNT_ETH} ETH each...`);
    console.log(`Funder address: ${await funder.getAddress()}`);
    console.log("=".repeat(80));

    let nonce = await provider.getTransactionCount(funder.address, 'pending');
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < targetAddresses.length; i++) {
        const targetAddress = targetAddresses[i];

        try {
            // Validate address format
            if (!ethers.isAddress(targetAddress)) {
                console.log(`\n❌ Account ${i + 1}/${targetAddresses.length}: ${targetAddress}`);
                console.log(`   Invalid address format`);
                failCount++;
                continue;
            }

            console.log(`\n📋 Account ${i + 1}/${targetAddresses.length}: ${targetAddress}`);

            // Check current balance
            const currentBalance = await provider.getBalance(targetAddress);
            console.log(`   Current balance: ${ethers.formatEther(currentBalance)} ETH`);

            // Send the transaction
            const tx = await funder.sendTransaction({
                to: targetAddress,
                value: AMOUNT_WEI,
                nonce: nonce++,
            });

            console.log(`   Transaction: ${tx.hash}`);
            console.log(`   Waiting for confirmation...`);

            await tx.wait();

            // Check new balance
            const newBalance = await provider.getBalance(targetAddress);
            console.log(`   New balance: ${ethers.formatEther(newBalance)} ETH`);
            console.log(`   ✅ Funded successfully!`);
            successCount++;
        } catch (error: any) {
            console.log(`\n❌ Account ${i + 1}/${targetAddresses.length}: ${targetAddress}`);
            console.log(`   Error: ${error.message || error}`);
            failCount++;
            // Continue with next account even if one fails
        }
    }

    console.log("\n" + "=".repeat(80));
    console.log(`\n✅ Funding complete!`);
    console.log(`   Successfully funded: ${successCount}/${targetAddresses.length}`);
    if (failCount > 0) {
        console.log(`   Failed: ${failCount}/${targetAddresses.length}`);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

