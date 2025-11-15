import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
const deployProposalNFT: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get } = hre.deployments;

  // Get the deployed ParcelNFT contract
  const parcelNFT = await get("ParcelNFT");
  const cityToken = await get("CityMemeToken");

  const proposalNFT = await deploy("ProposalNFT", {
    from: deployer,
    args: [parcelNFT.address, cityToken.address],
    log: true,
    autoMine: true,
  });

  console.log(`ProposalNFT deployed to: ${proposalNFT.address}`);
};

export default deployProposalNFT;
deployProposalNFT.tags = ["ProposalNFT"];
deployProposalNFT.dependencies = ["ParcelNFT", "CityMemeToken"]; 