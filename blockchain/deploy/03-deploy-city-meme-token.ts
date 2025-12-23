import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import path from "path";
import { colorizeDeploy } from "./deploy-colors";
// Load .env from parent directory
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const deployCityMemeToken: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  // Deploy the contract
  const cityMemeToken = await deploy("CityMemeToken", {
    from: deployer,
    args: [],
    log: true,
    autoMine: true,
  });

  console.log(colorizeDeploy(`CityMemeToken deployed to: ${cityMemeToken.address}`, 2));

  // Get contract instance
  const CityMemeToken = await ethers.getContractAt("CityMemeToken", cityMemeToken.address);

  // Check if the supply has been minted
  const supply = await CityMemeToken.MAX_SUPPLY();
  const mintedSupply = await CityMemeToken.totalSupply();
  if (mintedSupply >= supply) {
    console.log("Supply has already been minted");
    return;
  }

  // Get addresses from .env
  const addresses = [];
  for (let i = 0; i <= 5; i++) {
    const envKey = `ACCOUNT_${i}_ADDRESS`;
    const addr = process.env[envKey];
    if (!addr) throw new Error(`${envKey} not found in .env`);
    addresses.push(addr);
  }

  // Amount for each address (except account_1)
  const amountPerAddress = ethers.parseEther("10000");
  
  // Calculate remaining amount for account_1
  const totalSupply = await CityMemeToken.MAX_SUPPLY();
  const reservedAmount = amountPerAddress * 5n; // 5 addresses get 10000 each
  const account0Amount = totalSupply - reservedAmount;

  // Mint to account_1 first
  console.log(`Minting ${ethers.formatEther(account0Amount)} tokens to ${addresses[0]}`);
  await CityMemeToken.mint(addresses[0], account0Amount);

  // Mint 10000 tokens to each of the other addresses
  for (let i = 1; i < 6; i++) {
    console.log(`Minting ${ethers.formatEther(amountPerAddress)} tokens to ${addresses[i]}`);
    await CityMemeToken.mint(addresses[i], amountPerAddress);
  }

  console.log("Token distribution completed");
};

export default deployCityMemeToken;
deployCityMemeToken.tags = ["CityMemeToken"]; 