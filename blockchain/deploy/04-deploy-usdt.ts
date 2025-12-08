import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { getAddress } from "ethers";
import * as dotenv from "dotenv";
import path from "path";
import { colorizeDeploy } from "./deploy-colors";

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const deployUsdt: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const usdt = await deploy("USDT", {
    from: deployer,
    args: [],
    log: true,
    autoMine: true,
  });

  console.log(colorizeDeploy(`USDT deployed to: ${usdt.address}`, 3));

  const USDT = await ethers.getContractAt("USDT", usdt.address);

  const maxSupply = await USDT.MAX_SUPPLY();
  const currentSupply = await USDT.totalSupply();

  if (currentSupply < maxSupply) {
    const mintAmount = maxSupply - currentSupply;
    console.log(`Minting ${ethers.formatUnits(mintAmount, 18)} USDT to deployer ${deployer}`);
    const mintTx = await USDT.mint(deployer, mintAmount);
    await mintTx.wait();
  } else {
    console.log("Max supply already minted");
  }

  const recipients: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const envKey = `ACCOUNT_${i}_ADDRESS`;
    const addr = process.env[envKey];
    if (!addr) throw new Error(`${envKey} not found in .env`);
    recipients.push(getAddress(addr));
  }

  const allocation = ethers.parseUnits("10000000", 18);

  for (const recipient of recipients) {
    const balance = await USDT.balanceOf(recipient);

    if (balance >= allocation) {
      console.log(`Skipping ${recipient}: balance already ${ethers.formatUnits(balance, 18)} USDT`);
      continue;
    }

    const amountToSend = allocation - balance;
    console.log(`Sending ${ethers.formatUnits(amountToSend, 18)} USDT to ${recipient}`);
    const tx = await USDT.transfer(recipient, amountToSend);
    await tx.wait();
  }

  console.log("USDT distribution completed");
};

export default deployUsdt;
deployUsdt.tags = ["USDT"];

