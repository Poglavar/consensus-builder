import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("CityMemeToken", () => {
  async function deployCityTokenFixture() {
    const [owner, citizen, other] = await ethers.getSigners();
    const cityToken = await ethers.deployContract("CityMemeToken");
    await cityToken.waitForDeployment();
    return { owner, citizen, other, cityToken };
  }

  it("registers citizens once and accrues withdrawable balance over time", async () => {
    const { citizen, cityToken } = await loadFixture(deployCityTokenFixture);

    await expect(cityToken.connect(citizen).registerAsCitizen()).to.emit(cityToken, "CitizenRegistered");
    await expect(cityToken.connect(citizen).registerAsCitizen()).to.be.revertedWith("Already registered");

    expect(await cityToken.availableBalance(citizen.address)).to.equal(0n);

    await time.increase(3 * 60 * 60);
    expect(await cityToken.availableBalance(citizen.address)).to.equal(ethers.parseEther("3"));

    await expect(cityToken.connect(citizen).withdraw(ethers.parseEther("2")))
      .to.emit(cityToken, "Withdrawal")
      .withArgs(citizen.address, ethers.parseEther("2"), ethers.parseEther("2"));

    expect(await cityToken.balanceOf(citizen.address)).to.equal(ethers.parseEther("2"));
    expect(await cityToken.availableBalance(citizen.address)).to.equal(ethers.parseEther("1"));
  });

  it("enforces owner-only minting and the max supply cap", async () => {
    const { owner, other, cityToken } = await loadFixture(deployCityTokenFixture);
    const maxSupply = await cityToken.MAX_SUPPLY();

    await expect(cityToken.connect(other).mint(other.address, 1n)).to.be.revertedWithCustomError(
      cityToken,
      "OwnableUnauthorizedAccount",
    );

    await cityToken.connect(owner).mint(owner.address, maxSupply);
    await expect(cityToken.connect(owner).mint(owner.address, 1n)).to.be.revertedWith("Exceeds max supply");
  });
});

describe("USDT", () => {
  async function deployUsdtFixture() {
    const [owner, other] = await ethers.getSigners();
    const usdt = await ethers.deployContract("USDT");
    await usdt.waitForDeployment();
    return { owner, other, usdt };
  }

  it("allows only the owner to mint and respects the supply cap", async () => {
    const { owner, other, usdt } = await loadFixture(deployUsdtFixture);
    const maxSupply = await usdt.MAX_SUPPLY();

    await expect(usdt.connect(other).mint(other.address, 1n)).to.be.revertedWithCustomError(
      usdt,
      "OwnableUnauthorizedAccount",
    );

    await usdt.connect(owner).mint(other.address, maxSupply);
    expect(await usdt.balanceOf(other.address)).to.equal(maxSupply);
    await expect(usdt.connect(owner).mint(other.address, 1n)).to.be.revertedWith("Exceeds max supply");
  });
});