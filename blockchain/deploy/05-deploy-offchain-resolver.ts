import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { isAddress } from "ethers";
import { colorizeDeploy } from "./deploy-colors";

// Deploys the ENS OffchainResolver for parcels.urbangametheory.eth.
// Required env (set in blockchain/.env before deploying):
//   ENS_GATEWAY_URL     e.g. https://api.urbangametheory.xyz/ens/{sender}/{data}.json
//   ENS_SIGNER_ADDRESS  the address of the gateway's ENS_GATEWAY_SIGNER_KEY
// After deploy: set parcels.urbangametheory.eth's resolver to this address.
const deployOffchainResolver: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const url = process.env.ENS_GATEWAY_URL;
  const signer = process.env.ENS_SIGNER_ADDRESS;
  if (!url || !signer) {
    throw new Error("Set ENS_GATEWAY_URL and ENS_SIGNER_ADDRESS in blockchain/.env before deploying OffchainResolver.");
  }
  if (!isAddress(signer)) {
    throw new Error(`ENS_SIGNER_ADDRESS is not a valid address: ${signer}`);
  }

  const resolver = await deploy("OffchainResolver", {
    from: deployer,
    args: [url, [signer]],
    log: true,
    autoMine: true,
  });

  console.log(colorizeDeploy(`OffchainResolver deployed to: ${resolver.address}`, 0));
  console.log(colorizeDeploy(`  url:    ${url}`, 0));
  console.log(colorizeDeploy(`  signer: ${signer}`, 0));
};

export default deployOffchainResolver;
deployOffchainResolver.tags = ["OffchainResolver"];
