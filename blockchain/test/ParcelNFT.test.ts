import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("ParcelNFT", () => {
  async function deployParcelFixture() {
    const [owner, recipient, other] = await ethers.getSigners();
    const parcelNFT = await ethers.deployContract("ParcelNFT");
    await parcelNFT.waitForDeployment();

    return { owner, recipient, other, parcelNFT };
  }

  function parcelTokenId(parcelId: string) {
    return BigInt(ethers.keccak256(ethers.toUtf8Bytes(parcelId)));
  }

  it("mints a parcel to the registry and exposes lookups by token and parcel id", async () => {
    const { parcelNFT } = await loadFixture(deployParcelFixture);
    const registry = await parcelNFT.getAddress();
    const parcelId = "HR-339318-7396";
    const metadataURI = "ipfs://parcel-7396";
    const tokenId = parcelTokenId(parcelId);

    await expect(parcelNFT.mintParcel(parcelId, metadataURI))
      .to.emit(parcelNFT, "ParcelMetadataUpdated")
      .withArgs(tokenId, metadataURI);

    // Parcels are soulbound to the registry contract — nobody owns them.
    expect(await parcelNFT.ownerOf(tokenId)).to.equal(registry);
    expect(await parcelNFT.ownerOfParcelId(parcelId)).to.equal(registry);
    expect(await parcelNFT.tokenIdForParcelId(parcelId)).to.equal(tokenId);
    expect(await parcelNFT.parcelIdForTokenId(tokenId)).to.equal(parcelId);
    expect(await parcelNFT.tokenURI(tokenId)).to.equal(metadataURI);

    const parcel = await parcelNFT.getParcelById(parcelId);
    expect(parcel.parcelId).to.equal(parcelId);
    expect(parcel.metadataURI).to.equal(metadataURI);

    const registryTokens = await parcelNFT.getTokensByOwner(registry);
    expect(registryTokens).to.deep.equal([tokenId]);
  });

  it("rejects duplicate parcel ids and empty metadata", async () => {
    const { parcelNFT } = await loadFixture(deployParcelFixture);
    const parcelId = "HR-339318-7396";

    await parcelNFT.mintParcel(parcelId, "ipfs://first");

    await expect(parcelNFT.mintParcel(parcelId, "ipfs://second")).to.be.revertedWith(
      "ParcelNFT: Parcel already minted",
    );

    await expect(parcelNFT.mintParcel("HR-339318-7397", "")).to.be.revertedWith(
      "ParcelNFT: metadata URI required",
    );
  });

  it("mints batches to the registry and validates batch inputs", async () => {
    const { parcelNFT } = await loadFixture(deployParcelFixture);
    const registry = await parcelNFT.getAddress();
    const parcelIds = ["HR-339318-7396", "HR-339318-7397"];
    const metadataURIs = ["ipfs://parcel-7396", "ipfs://parcel-7397"];

    await expect(parcelNFT.mintBatch(parcelIds, metadataURIs)).not.to.be.reverted;

    expect(await parcelNFT.ownerOf(parcelTokenId(parcelIds[0]))).to.equal(registry);
    expect(await parcelNFT.ownerOf(parcelTokenId(parcelIds[1]))).to.equal(registry);

    await expect(parcelNFT.mintBatch(parcelIds, [metadataURIs[0]])).to.be.revertedWith(
      "ParcelNFT: parcelIds and metadataURIs length mismatch",
    );
  });

  it("makes parcels soulbound (non-transferable)", async () => {
    const { recipient, parcelNFT } = await loadFixture(deployParcelFixture);
    const registry = await parcelNFT.getAddress();
    const parcelId = "HR-339318-7396";
    const tokenId = parcelTokenId(parcelId);

    await parcelNFT.mintParcel(parcelId, "ipfs://parcel");

    // The registry holds the token and there is no entrypoint to move it; any
    // transfer attempt reverts, so parcels can never change hands.
    await expect(
      parcelNFT.connect(recipient).transferFrom(registry, recipient.address, tokenId),
    ).to.be.reverted;
  });

  it("only lets the contract owner update metadata", async () => {
    const { owner, other, parcelNFT } = await loadFixture(deployParcelFixture);
    const parcelId = "HR-339318-7396";
    const tokenId = parcelTokenId(parcelId);

    await parcelNFT.connect(owner).mintParcel(parcelId, "ipfs://before");

    await expect(parcelNFT.connect(other).setParcelMetadataURI(tokenId, "ipfs://after")).to.be.revertedWithCustomError(
      parcelNFT,
      "OwnableUnauthorizedAccount",
    );

    await expect(parcelNFT.connect(owner).setParcelMetadataURI(tokenId, "ipfs://after"))
      .to.emit(parcelNFT, "ParcelMetadataUpdated")
      .withArgs(tokenId, "ipfs://after");

    expect(await parcelNFT.tokenURI(tokenId)).to.equal("ipfs://after");
  });
});