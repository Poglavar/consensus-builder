import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { getAddress } from "ethers";
import * as dotenv from "dotenv";
import path from "path";
import { colorizeDeploy } from "./deploy-colors";

// Ensure we load the root .env (same approach as deploy 03)
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const deployProposalNFT: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get } = hre.deployments;
  const chainId = await hre.getChainId();

  const ownThisSchemaUid = process.env.OWN_THIS_SCHEMA_UID;
  const endorsementSchemaUid = process.env.ENDORSE_SCHEMA_UID;
  const ownerListSchemaUid = process.env.OWNER_LIST_SCHEMA_UID;

  if (!ownThisSchemaUid) {
    throw new Error("OWN_THIS_SCHEMA_UID not found in .env");
  }
  if (!endorsementSchemaUid) {
    throw new Error("ENDORSE_SCHEMA_UID not found in .env");
  }
  if (!ownerListSchemaUid) {
    throw new Error("OWNER_LIST_SCHEMA_UID not found in .env");
  }

  const parcelNFT = await get("ParcelNFT");
  const cityToken = await get("CityMemeToken");
  const easAddress = pickEasAddress(chainId);

  const proposalNFT = await deploy("ProposalNFT", {
    from: deployer,
    args: [
      parcelNFT.address,
      cityToken.address,
      easAddress,
      ownThisSchemaUid,
      endorsementSchemaUid,
      ownerListSchemaUid,
    ],
    log: true,
    autoMine: true,
  });

  console.log(colorizeDeploy(`ProposalNFT deployed to: ${proposalNFT.address}`, 1));
};

export default deployProposalNFT;
deployProposalNFT.tags = ["ProposalNFT"];
deployProposalNFT.dependencies = ["ParcelNFT", "CityMemeToken"];

function pickEasAddress(chainId: string): string {
  const envCandidates = [process.env.EAS_ADDRESS, process.env[`EAS_ADDRESS_${chainId}`]].filter(
    (v): v is string => Boolean(v),
  );

  if (envCandidates.length === 0) {
    throw new Error(`EAS address not found. Set EAS_ADDRESS or EAS_ADDRESS_${chainId} in .env`);
  }

  return getAddress(envCandidates[0]);
}