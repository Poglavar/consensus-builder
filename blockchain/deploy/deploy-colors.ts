import { HardhatRuntimeEnvironment } from "hardhat/types";

export const DEPLOY_COLOR_RAMP = [
  "\x1b[96m", // bright cyan
  "\x1b[92m", // bright green
  "\x1b[93m", // bright yellow
  "\x1b[91m", // bright red
  "\x1b[95m", // bright magenta fallback
];

export function colorizeDeploy(line: string, order: number): string {
  const safeIndex = Math.max(0, Math.min(order, DEPLOY_COLOR_RAMP.length - 1));
  return `${DEPLOY_COLOR_RAMP[safeIndex]}${line}\x1b[0m`;
}

// Hardhat-deploy expects a default-exported deploy function in this folder.
// Provide a no-op that is skipped.
const func = async (_hre: HardhatRuntimeEnvironment) => {
  return;
};

func.tags = ["deploy-colors-util"];
func.skip = async () => true;

export default func;

