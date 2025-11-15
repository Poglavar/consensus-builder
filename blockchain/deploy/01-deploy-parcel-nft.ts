import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
const deployParcelNFT: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const parcelNFT = await deploy("ParcelNFT", {
    from: deployer,
    args: [],
    log: true,
    autoMine: true,
  });

  console.log(`ParcelNFT deployed to: ${parcelNFT.address}`);
};

export default deployParcelNFT;
deployParcelNFT.tags = ["ParcelNFT"]; 