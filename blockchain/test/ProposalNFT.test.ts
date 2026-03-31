import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("ProposalNFT", () => {
  const ownThisSchemaUid = ethers.id("OWN_THIS");
  const endorsementSchemaUid = ethers.id("ENDORSEMENT");
  const ownerListSchemaUid = ethers.id("OWNER_LIST");

  async function deployProposalFixture() {
    const [deployer, proposalOwner, accepter, lensMember, outsider] = await ethers.getSigners();

    const parcelNFT = await ethers.deployContract("ParcelNFT");
    const cityToken = await ethers.deployContract("CityMemeToken");
    const eas = await ethers.deployContract("MockEAS");

    await Promise.all([
      parcelNFT.waitForDeployment(),
      cityToken.waitForDeployment(),
      eas.waitForDeployment(),
    ]);

    const proposalNFT = await ethers.deployContract("ProposalNFT", [
      await parcelNFT.getAddress(),
      await cityToken.getAddress(),
      await eas.getAddress(),
      ownThisSchemaUid,
      endorsementSchemaUid,
      ownerListSchemaUid,
    ]);
    await proposalNFT.waitForDeployment();

    const fundingAmount = ethers.parseUnits("1000", 18);
    await cityToken.mint(proposalOwner.address, fundingAmount);

    return {
      deployer,
      proposalOwner,
      accepter,
      lensMember,
      outsider,
      parcelNFT,
      cityToken,
      eas,
      proposalNFT,
      fundingAmount,
    };
  }

  function parcelTokenId(parcelId: string) {
    return BigInt(ethers.keccak256(ethers.toUtf8Bytes(parcelId)));
  }

  async function setOwnershipAttestations({
    eas,
    claimUid,
    endorsementUid,
    parcelNFTAddress,
    tokenId,
    claimant,
    lensMember,
    claimExpirationTime = 0n,
    endorsementExpirationTime = 0n,
    claimRevocationTime = 0n,
    endorsementRevocationTime = 0n,
    claimSchema = ownThisSchemaUid,
    endorsementSchema = endorsementSchemaUid,
    claimRecipient = claimant,
    claimAttester = claimant,
    endorsementRecipient = claimant,
    endorsementAttester = lensMember,
    endorsementRefUid = claimUid,
    endorsementValue = true,
    claimLabel = "I own this",
    targetChainOverride,
    targetAddressOverride,
    targetIdOverride,
  }: {
    eas: any;
    claimUid: string;
    endorsementUid: string;
    parcelNFTAddress: string;
    tokenId: bigint;
    claimant: string;
    lensMember: string;
    claimExpirationTime?: bigint;
    endorsementExpirationTime?: bigint;
    claimRevocationTime?: bigint;
    endorsementRevocationTime?: bigint;
    claimSchema?: string;
    endorsementSchema?: string;
    claimRecipient?: string;
    claimAttester?: string;
    endorsementRecipient?: string;
    endorsementAttester?: string;
    endorsementRefUid?: string;
    endorsementValue?: boolean;
    claimLabel?: string;
    targetChainOverride?: string;
    targetAddressOverride?: string;
    targetIdOverride?: string;
  }) {
    const chainId = (await ethers.provider.getNetwork()).chainId.toString();
    const targetAddress = parcelNFTAddress.toLowerCase();
    const targetId = tokenId.toString();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;

    await eas.setAttestation({
      uid: claimUid,
      schema: claimSchema,
      time: BigInt(now),
      expirationTime: claimExpirationTime,
      revocationTime: claimRevocationTime,
      refUID: ethers.ZeroHash,
      recipient: claimRecipient,
      attester: claimAttester,
      revocable: true,
      data: ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "string", "string"],
        [
          claimLabel,
          targetChainOverride ?? chainId,
          targetAddressOverride ?? targetAddress,
          targetIdOverride ?? targetId,
        ],
      ),
    });

    await eas.setAttestation({
      uid: endorsementUid,
      schema: endorsementSchema,
      time: BigInt(now),
      expirationTime: endorsementExpirationTime,
      revocationTime: endorsementRevocationTime,
      refUID: endorsementRefUid,
      recipient: endorsementRecipient,
      attester: endorsementAttester,
      revocable: true,
      data: ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [endorsementValue]),
    });
  }

  async function setOwnerListAttestation({
    eas,
    ownerListUid,
    parcelNFTAddress,
    tokenId,
    lensMember,
    owners,
    expirationTime = 0n,
  }: {
    eas: any;
    ownerListUid: string;
    parcelNFTAddress: string;
    tokenId: bigint;
    lensMember: string;
    owners: Array<{ name: string; owner: string; dptoNumber: string; shareBps: bigint }>;
    expirationTime?: bigint;
  }) {
    const chainId = (await ethers.provider.getNetwork()).chainId.toString();
    const targetAddress = parcelNFTAddress.toLowerCase();
    const targetId = tokenId.toString();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;

    await eas.setAttestation({
      uid: ownerListUid,
      schema: ownerListSchemaUid,
      time: BigInt(now),
      expirationTime,
      revocationTime: 0n,
      refUID: ethers.ZeroHash,
      recipient: ethers.ZeroAddress,
      attester: lensMember,
      revocable: true,
      data: ethers.AbiCoder.defaultAbiCoder().encode(
        [
          "string",
          "string",
          "string",
          "tuple(string name,address owner,string dptoNumber,uint256 shareBps)[]",
        ],
        [chainId, targetAddress, targetId, owners],
      ),
    });
  }

  async function setProposalExpiryTimestamp(proposalNFT: any, proposalId: bigint | number, expiryTimestamp: bigint) {
    const mappingSlot = 15n;
    const proposalBaseSlot = BigInt(
      ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [proposalId, mappingSlot])),
    );
    const expirySlot = proposalBaseSlot + 12n;

    await ethers.provider.send("hardhat_setStorageAt", [
      await proposalNFT.getAddress(),
      ethers.toBeHex(expirySlot, 32),
      ethers.toBeHex(expiryTimestamp, 32),
    ]);
    await ethers.provider.send("evm_mine", []);
  }

  it("mints and funds a proposal, then executes when all parcels accept", async () => {
    const { proposalOwner, accepter, lensMember, parcelNFT, cityToken, eas, proposalNFT } =
      await loadFixture(deployProposalFixture);
    const parcelId = "HR-339318-7396";
    const parcelId2 = "HR-339318-7397";
    const proposalFunding = ethers.parseUnits("250", 18);

    await parcelNFT.mintBatch(accepter.address, [parcelId, parcelId2], ["ipfs://p1", "ipfs://p2"]);
    await cityToken.connect(proposalOwner).approve(await proposalNFT.getAddress(), proposalFunding);

    await expect(
      proposalNFT
        .connect(proposalOwner)
        .mintAndFund(proposalOwner.address, [parcelId], false, "ipfs://proposal", 0, proposalFunding, [lensMember.address]),
    ).not.to.be.reverted;

    const proposalIds = await proposalNFT.getProposalsForParcel(parcelId);
    expect(proposalIds).to.deep.equal([0n]);

    const claimUid = ethers.id("claim-1");
    const endorsementUid = ethers.id("endorsement-1");
    await setOwnershipAttestations({
      eas,
      claimUid,
      endorsementUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId: parcelTokenId(parcelId),
      claimant: accepter.address,
      lensMember: lensMember.address,
    });

    const beforeBalance = await cityToken.balanceOf(accepter.address);
    await expect(proposalNFT.connect(accepter).acceptProposal(0, parcelId, ethers.ZeroHash, claimUid, endorsementUid))
      .to.emit(proposalNFT, "ProposalAccepted")
      .withArgs(0, parcelId, accepter.address);

    const afterBalance = await cityToken.balanceOf(accepter.address);
    expect(afterBalance - beforeBalance).to.equal(proposalFunding);

    const proposal = await proposalNFT.getProposal(0);
    expect(proposal.status).to.equal(1n);
    expect(proposal.acceptancePossible).to.equal(false);
    expect(proposal.acceptanceCount).to.equal(1n);
    expect(await proposalNFT.hasAccepted(0, parcelId)).to.equal(true);
    expect(await proposalNFT.tokenURI(0)).to.equal("ipfs://proposal");
    expect(await proposalNFT.getLens(0)).to.deep.equal([lensMember.address]);
  });

  it("rejects invalid funding and duplicate lens configuration", async () => {
    const { proposalOwner, lensMember, parcelNFT, cityToken, proposalNFT } = await loadFixture(deployProposalFixture);
    const parcelId = "HR-339318-7396";
    const funding = ethers.parseUnits("50", 18);

    await parcelNFT.mintParcel(proposalOwner.address, parcelId, "ipfs://parcel");
    await cityToken.connect(proposalOwner).approve(await proposalNFT.getAddress(), funding);

    await expect(
      proposalNFT
        .connect(proposalOwner)
        .mintAndFund(proposalOwner.address, [parcelId], false, "ipfs://proposal", 1n, funding, [lensMember.address], {
          value: 0,
        }),
    ).to.be.revertedWith("ProposalNFT: ETH amount mismatch");

    await expect(
      proposalNFT
        .connect(proposalOwner)
        .mintAndFund(proposalOwner.address, [parcelId], false, "ipfs://proposal", 0, funding, [lensMember.address, lensMember.address]),
    ).to.be.revertedWith("ProposalNFT: Duplicate lens address");

    await expect(
      proposalNFT
        .connect(proposalOwner)
        .mintAndFund(proposalOwner.address, [parcelId], false, "ipfs://proposal", 0, funding + 1n, [lensMember.address]),
    ).to.be.revertedWith("ProposalNFT: Token allowance insufficient");
  });

  it("allows withdrawing acceptance on active conditional proposals", async () => {
    const { proposalOwner, accepter, lensMember, outsider, parcelNFT, cityToken, eas, proposalNFT } =
      await loadFixture(deployProposalFixture);
    const parcelIds = ["HR-339318-7396", "HR-339318-7397"];
    const funding = ethers.parseUnits("100", 18);

    await parcelNFT.mintBatch(accepter.address, parcelIds, ["ipfs://p1", "ipfs://p2"]);
    await cityToken.connect(proposalOwner).approve(await proposalNFT.getAddress(), funding);
    await proposalNFT
      .connect(proposalOwner)
      .mintAndFund(proposalOwner.address, parcelIds, true, "ipfs://conditional", 0, funding, [lensMember.address]);

    const claimUid = ethers.id("claim-conditional");
    const endorsementUid = ethers.id("endorsement-conditional");
    await setOwnershipAttestations({
      eas,
      claimUid,
      endorsementUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId: parcelTokenId(parcelIds[0]),
      claimant: accepter.address,
      lensMember: lensMember.address,
    });

    await proposalNFT.connect(accepter).acceptProposal(0, parcelIds[0], ethers.ZeroHash, claimUid, endorsementUid);
    expect(await proposalNFT.hasAccepted(0, parcelIds[0])).to.equal(true);

    await expect(
      proposalNFT.connect(outsider).withdrawAcceptance(0, parcelIds[0], ethers.ZeroHash, claimUid, endorsementUid),
    ).to.be.revertedWith("ProposalNFT: Caller did not accept");

    await expect(
      proposalNFT.connect(accepter).withdrawAcceptance(0, parcelIds[0], ethers.ZeroHash, claimUid, endorsementUid),
    )
      .to.emit(proposalNFT, "ProposalAcceptanceWithdrawn")
      .withArgs(0, parcelIds[0], accepter.address);

    expect(await proposalNFT.hasAccepted(0, parcelIds[0])).to.equal(false);
    const proposal = await proposalNFT.getProposal(0);
    expect(proposal.status).to.equal(0n);
    expect(proposal.acceptanceCount).to.equal(0n);
    expect(proposal.acceptancePossible).to.equal(true);
  });

  it("lets the owner cancel an active proposal and recover escrowed city tokens", async () => {
    const { proposalOwner, lensMember, parcelNFT, cityToken, proposalNFT, fundingAmount } =
      await loadFixture(deployProposalFixture);
    const parcelId = "HR-339318-7396";
    const fundedAmount = ethers.parseUnits("125", 18);

    await parcelNFT.mintParcel(proposalOwner.address, parcelId, "ipfs://parcel");
    await cityToken.connect(proposalOwner).approve(await proposalNFT.getAddress(), fundedAmount);
    await proposalNFT
      .connect(proposalOwner)
      .mintAndFund(proposalOwner.address, [parcelId], false, "ipfs://proposal", 0, fundedAmount, [lensMember.address]);

    expect(await cityToken.balanceOf(proposalOwner.address)).to.equal(fundingAmount - fundedAmount);

    await expect(proposalNFT.connect(proposalOwner).distributeFunds(0)).to.emit(proposalNFT, "FundsDistributed");

    expect(await cityToken.balanceOf(proposalOwner.address)).to.equal(fundingAmount);
    const proposal = await proposalNFT.getProposal(0);
    expect(proposal.status).to.equal(2n);
    expect(proposal.acceptancePossible).to.equal(false);
  });

  it("uses owner lists to require all listed owners before a parcel counts as accepted", async () => {
    const { proposalOwner, accepter, outsider, lensMember, parcelNFT, cityToken, eas, proposalNFT } =
      await loadFixture(deployProposalFixture);
    const parcelId = "HR-339318-7396";
    const funding = ethers.parseUnits("1000", 18);

    await parcelNFT.mintParcel(accepter.address, parcelId, "ipfs://parcel");
    await cityToken.connect(proposalOwner).approve(await proposalNFT.getAddress(), funding);
    await proposalNFT
      .connect(proposalOwner)
      .mintAndFund(proposalOwner.address, [parcelId], true, "ipfs://proposal", 0, funding, [lensMember.address]);

    const ownerListUid = ethers.id("owner-list-1");
    await setOwnerListAttestation({
      eas,
      ownerListUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId: parcelTokenId(parcelId),
      lensMember: lensMember.address,
      owners: [
        { name: "Alice", owner: accepter.address, dptoNumber: "1", shareBps: 7000n },
        { name: "Bob", owner: outsider.address, dptoNumber: "2", shareBps: 3000n },
      ],
    });

    const claimUid1 = ethers.id("claim-owner-1");
    const endorsementUid1 = ethers.id("endorsement-owner-1");
    await setOwnershipAttestations({
      eas,
      claimUid: claimUid1,
      endorsementUid: endorsementUid1,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId: parcelTokenId(parcelId),
      claimant: accepter.address,
      lensMember: lensMember.address,
    });

    const claimUid2 = ethers.id("claim-owner-2");
    const endorsementUid2 = ethers.id("endorsement-owner-2");
    await setOwnershipAttestations({
      eas,
      claimUid: claimUid2,
      endorsementUid: endorsementUid2,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId: parcelTokenId(parcelId),
      claimant: outsider.address,
      lensMember: lensMember.address,
    });

    await proposalNFT.connect(accepter).acceptProposal(0, parcelId, ownerListUid, claimUid1, endorsementUid1);
    expect(await proposalNFT.hasAccepted(0, parcelId)).to.equal(false);
    expect((await proposalNFT.getProposal(0)).acceptanceCount).to.equal(0n);

    const accepterBefore = await cityToken.balanceOf(accepter.address);
    const outsiderBefore = await cityToken.balanceOf(outsider.address);

    await proposalNFT.connect(outsider).acceptProposal(0, parcelId, ownerListUid, claimUid2, endorsementUid2);

    expect(await proposalNFT.hasAccepted(0, parcelId)).to.equal(true);
    const proposal = await proposalNFT.getProposal(0);
    expect(proposal.status).to.equal(1n);
    expect(proposal.acceptancePossible).to.equal(false);
    expect(proposal.acceptanceCount).to.equal(1n);

    expect((await cityToken.balanceOf(accepter.address)) - accepterBefore).to.equal(ethers.parseUnits("700", 18));
    expect((await cityToken.balanceOf(outsider.address)) - outsiderBefore).to.equal(ethers.parseUnits("300", 18));
  });

  it("allows contributors to add ETH and city tokens while a proposal is still active", async () => {
    const { proposalOwner, accepter, lensMember, parcelNFT, cityToken, proposalNFT } =
      await loadFixture(deployProposalFixture);
    const parcelId = "HR-339318-7396";
    const initialFunding = ethers.parseUnits("100", 18);
    const tokenContribution = ethers.parseUnits("50", 18);
    const ethContribution = ethers.parseEther("0.75");

    await parcelNFT.mintParcel(proposalOwner.address, parcelId, "ipfs://parcel");
    await cityToken.connect(proposalOwner).approve(await proposalNFT.getAddress(), initialFunding);
    await proposalNFT
      .connect(proposalOwner)
      .mintAndFund(proposalOwner.address, [parcelId], false, "ipfs://proposal", 0, initialFunding, [lensMember.address]);

    await cityToken.mint(accepter.address, tokenContribution);
    await cityToken.connect(accepter).approve(await proposalNFT.getAddress(), tokenContribution);

    await expect(proposalNFT.connect(accepter).contributeFunds(0, await cityToken.getAddress(), tokenContribution))
      .to.emit(proposalNFT, "FundsContributed")
      .withArgs(0, await cityToken.getAddress(), tokenContribution);

    await expect(
      proposalNFT.connect(accepter).contributeFunds(0, ethers.ZeroAddress, ethContribution, { value: ethContribution }),
    )
      .to.emit(proposalNFT, "FundsContributed")
      .withArgs(0, ethers.ZeroAddress, ethContribution);

    const proposal = await proposalNFT.getProposal(0);
    expect(proposal.ethBalance).to.equal(ethContribution);
    expect(proposal.tokenBalance).to.equal(initialFunding + tokenContribution);
  });

  it("returns escrow to the owner when an expired proposal is processed", async () => {
    const { proposalOwner, outsider, lensMember, parcelNFT, cityToken, proposalNFT, fundingAmount } =
      await loadFixture(deployProposalFixture);
    const parcelId = "HR-339318-7396";
    const tokenFunding = ethers.parseUnits("125", 18);
    const ethFunding = ethers.parseEther("1.25");

    await parcelNFT.mintParcel(proposalOwner.address, parcelId, "ipfs://parcel");
    await cityToken.connect(proposalOwner).approve(await proposalNFT.getAddress(), tokenFunding);
    await proposalNFT
      .connect(proposalOwner)
      .mintAndFund(proposalOwner.address, [parcelId], false, "ipfs://proposal", ethFunding, tokenFunding, [lensMember.address], {
        value: ethFunding,
      });

    const ownerEthBefore = await ethers.provider.getBalance(proposalOwner.address);
    expect(await cityToken.balanceOf(proposalOwner.address)).to.equal(fundingAmount - tokenFunding);

    const latest = await time.latest();
    await setProposalExpiryTimestamp(proposalNFT, 0n, BigInt(latest));

    await expect(proposalNFT.connect(outsider).distributeFunds(0))
      .to.emit(proposalNFT, "FundsDistributed")
      .withArgs(0, ethFunding, tokenFunding);

    expect(await cityToken.balanceOf(proposalOwner.address)).to.equal(fundingAmount);

    const ownerEthAfter = await ethers.provider.getBalance(proposalOwner.address);
    expect(ownerEthAfter - ownerEthBefore).to.equal(ethFunding);

    const proposal = await proposalNFT.getProposal(0);
    expect(proposal.status).to.equal(3n);
    expect(proposal.acceptancePossible).to.equal(false);
  });

  it("rejects acceptance when a proposal has expired", async () => {
    const { proposalOwner, accepter, lensMember, parcelNFT, cityToken, eas, proposalNFT } =
      await loadFixture(deployProposalFixture);
    const parcelId = "HR-339318-7396";
    const tokenFunding = ethers.parseUnits("100", 18);

    await parcelNFT.mintParcel(accepter.address, parcelId, "ipfs://parcel");
    await cityToken.connect(proposalOwner).approve(await proposalNFT.getAddress(), tokenFunding);
    await proposalNFT
      .connect(proposalOwner)
      .mintAndFund(proposalOwner.address, [parcelId], false, "ipfs://proposal", 0, tokenFunding, [lensMember.address]);

    const claimUid = ethers.id("claim-expired-proposal");
    const endorsementUid = ethers.id("endorsement-expired-proposal");
    await setOwnershipAttestations({
      eas,
      claimUid,
      endorsementUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId: parcelTokenId(parcelId),
      claimant: accepter.address,
      lensMember: lensMember.address,
    });

    const latest = await time.latest();
    await setProposalExpiryTimestamp(proposalNFT, 0n, BigInt(latest));

    await expect(
      proposalNFT.connect(accepter).acceptProposal(0, parcelId, ethers.ZeroHash, claimUid, endorsementUid),
    ).to.be.revertedWith("ProposalNFT: Proposal has expired");
  });

  it("rejects expired claims and endorsements during acceptance", async () => {
    const { proposalOwner, accepter, lensMember, parcelNFT, cityToken, eas, proposalNFT } =
      await loadFixture(deployProposalFixture);
    const parcelId = "HR-339318-7396";
    const tokenFunding = ethers.parseUnits("100", 18);

    await parcelNFT.mintParcel(accepter.address, parcelId, "ipfs://parcel");
    await cityToken.connect(proposalOwner).approve(await proposalNFT.getAddress(), tokenFunding);
    await proposalNFT
      .connect(proposalOwner)
      .mintAndFund(proposalOwner.address, [parcelId], false, "ipfs://proposal", 0, tokenFunding, [lensMember.address]);

    const latest = BigInt(await time.latest());

    const expiredClaimUid = ethers.id("claim-expired-claim");
    const expiredClaimEndorsementUid = ethers.id("endorsement-expired-claim");
    await setOwnershipAttestations({
      eas,
      claimUid: expiredClaimUid,
      endorsementUid: expiredClaimEndorsementUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId: parcelTokenId(parcelId),
      claimant: accepter.address,
      lensMember: lensMember.address,
      claimExpirationTime: latest,
    });

    await expect(
      proposalNFT
        .connect(accepter)
        .acceptProposal(0, parcelId, ethers.ZeroHash, expiredClaimUid, expiredClaimEndorsementUid),
    ).to.be.revertedWith("ProposalNFT: Claim expired");

    const validClaimUid = ethers.id("claim-valid-endorsement-expired");
    const expiredEndorsementUid = ethers.id("endorsement-expired");
    await setOwnershipAttestations({
      eas,
      claimUid: validClaimUid,
      endorsementUid: expiredEndorsementUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId: parcelTokenId(parcelId),
      claimant: accepter.address,
      lensMember: lensMember.address,
      endorsementExpirationTime: latest,
    });

    await expect(
      proposalNFT.connect(accepter).acceptProposal(0, parcelId, ethers.ZeroHash, validClaimUid, expiredEndorsementUid),
    ).to.be.revertedWith("ProposalNFT: Endorsement expired");
  });

  it("rejects expired owner list attestations", async () => {
    const { proposalOwner, accepter, outsider, lensMember, parcelNFT, cityToken, eas, proposalNFT } =
      await loadFixture(deployProposalFixture);
    const parcelId = "HR-339318-7396";
    const funding = ethers.parseUnits("1000", 18);

    await parcelNFT.mintParcel(accepter.address, parcelId, "ipfs://parcel");
    await cityToken.connect(proposalOwner).approve(await proposalNFT.getAddress(), funding);
    await proposalNFT
      .connect(proposalOwner)
      .mintAndFund(proposalOwner.address, [parcelId], true, "ipfs://proposal", 0, funding, [lensMember.address]);

    const latest = BigInt(await time.latest());
    const ownerListUid = ethers.id("owner-list-expired");
    await setOwnerListAttestation({
      eas,
      ownerListUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId: parcelTokenId(parcelId),
      lensMember: lensMember.address,
      expirationTime: latest,
      owners: [
        { name: "Alice", owner: accepter.address, dptoNumber: "1", shareBps: 7000n },
        { name: "Bob", owner: outsider.address, dptoNumber: "2", shareBps: 3000n },
      ],
    });

    const claimUid = ethers.id("claim-owner-list-expired");
    const endorsementUid = ethers.id("endorsement-owner-list-expired");
    await setOwnershipAttestations({
      eas,
      claimUid,
      endorsementUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId: parcelTokenId(parcelId),
      claimant: accepter.address,
      lensMember: lensMember.address,
    });

    await expect(
      proposalNFT.connect(accepter).acceptProposal(0, parcelId, ownerListUid, claimUid, endorsementUid),
    ).to.be.revertedWith("ProposalNFT: Owner list expired");
  });

  it("reports parcel acceptance and proposal details through batch readers", async () => {
    const { proposalOwner, accepter, lensMember, parcelNFT, cityToken, eas, proposalNFT } =
      await loadFixture(deployProposalFixture);
    const parcelIds = ["HR-339318-7396", "HR-339318-7397"];
    const tokenFunding = ethers.parseUnits("100", 18);

    await parcelNFT.mintBatch(accepter.address, parcelIds, ["ipfs://p1", "ipfs://p2"]);
    await cityToken.connect(proposalOwner).approve(await proposalNFT.getAddress(), tokenFunding * 2n);

    await proposalNFT
      .connect(proposalOwner)
      .mintAndFund(proposalOwner.address, [parcelIds[0]], false, "ipfs://proposal-0", 0, tokenFunding, [lensMember.address]);
    await proposalNFT
      .connect(proposalOwner)
      .mintAndFund(proposalOwner.address, [parcelIds[0], parcelIds[1]], true, "ipfs://proposal-1", 0, tokenFunding, [lensMember.address]);

    const claimUid = ethers.id("claim-batch-status");
    const endorsementUid = ethers.id("endorsement-batch-status");
    await setOwnershipAttestations({
      eas,
      claimUid,
      endorsementUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId: parcelTokenId(parcelIds[0]),
      claimant: accepter.address,
      lensMember: lensMember.address,
    });

    await proposalNFT.connect(accepter).acceptProposal(1, parcelIds[0], ethers.ZeroHash, claimUid, endorsementUid);

    const [proposalIds, acceptanceStatus] = await proposalNFT.getProposalsForParcelWithStatus(parcelIds[0]);
    expect(proposalIds).to.deep.equal([0n, 1n]);
    expect(acceptanceStatus).to.deep.equal([false, true]);

    const batch = await proposalNFT.getProposalsBatch([0n, 1n]);
    expect(batch.parcelIdsArray[0]).to.deep.equal([parcelIds[0]]);
    expect(batch.parcelIdsArray[1]).to.deep.equal(parcelIds);
    expect(batch.isConditionalArray).to.deep.equal([false, true]);
    expect(batch.imageURIArray).to.deep.equal(["ipfs://proposal-0", "ipfs://proposal-1"]);
    expect(batch.acceptancePossibleArray).to.deep.equal([true, true]);
    expect(batch.statusArray).to.deep.equal([0n, 0n]);
    expect(batch.tokenBalanceArray).to.deep.equal([tokenFunding, tokenFunding]);
    expect(batch.acceptanceCountArray).to.deep.equal([0n, 1n]);
    expect(batch.expiryTimestampArray).to.deep.equal([0n, 0n]);
    expect(batch.expiringPercentageArray).to.deep.equal([0n, 0n]);
  });

  it("rejects invalid contribution inputs and contributions after a proposal closes", async () => {
    const { proposalOwner, accepter, lensMember, parcelNFT, cityToken, proposalNFT } =
      await loadFixture(deployProposalFixture);
    const parcelId = "HR-339318-7396";
    const tokenFunding = ethers.parseUnits("100", 18);

    await parcelNFT.mintParcel(proposalOwner.address, parcelId, "ipfs://parcel");
    await cityToken.connect(proposalOwner).approve(await proposalNFT.getAddress(), tokenFunding);
    await proposalNFT
      .connect(proposalOwner)
      .mintAndFund(proposalOwner.address, [parcelId], false, "ipfs://proposal", 0, tokenFunding, [lensMember.address]);

    await cityToken.mint(accepter.address, tokenFunding);
    await cityToken.connect(accepter).approve(await proposalNFT.getAddress(), tokenFunding);

    await expect(proposalNFT.connect(accepter).contributeFunds(0, ethers.ZeroAddress, 0n)).to.be.revertedWith(
      "ProposalNFT: Contribution must be greater than zero",
    );

    await expect(
      proposalNFT.connect(accepter).contributeFunds(0, await cityToken.getAddress(), 1n, { value: 1n }),
    ).to.be.revertedWith("ProposalNFT: Do not send ETH with token contribution");

    await expect(
      proposalNFT.connect(accepter).contributeFunds(0, ethers.ZeroAddress, ethers.parseEther("1"), { value: 0 }),
    ).to.be.revertedWith("ProposalNFT: ETH amount mismatch");

    await proposalNFT.connect(proposalOwner).distributeFunds(0);

    await expect(
      proposalNFT.connect(accepter).contributeFunds(0, await cityToken.getAddress(), 1n),
    ).to.be.revertedWith("ProposalNFT: Proposal acceptance is not possible");
  });

  it("rejects revoked claims and endorsements", async () => {
    const { proposalOwner, accepter, lensMember, parcelNFT, cityToken, eas, proposalNFT } =
      await loadFixture(deployProposalFixture);
    const parcelId = "HR-339318-7396";
    const tokenFunding = ethers.parseUnits("100", 18);

    await parcelNFT.mintParcel(accepter.address, parcelId, "ipfs://parcel");
    await cityToken.connect(proposalOwner).approve(await proposalNFT.getAddress(), tokenFunding);
    await proposalNFT
      .connect(proposalOwner)
      .mintAndFund(proposalOwner.address, [parcelId], false, "ipfs://proposal", 0, tokenFunding, [lensMember.address]);

    const revokedClaimUid = ethers.id("claim-revoked");
    const revokedClaimEndorsementUid = ethers.id("endorsement-for-revoked-claim");
    await setOwnershipAttestations({
      eas,
      claimUid: revokedClaimUid,
      endorsementUid: revokedClaimEndorsementUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId: parcelTokenId(parcelId),
      claimant: accepter.address,
      lensMember: lensMember.address,
      claimRevocationTime: 1n,
    });

    await expect(
      proposalNFT.connect(accepter).acceptProposal(0, parcelId, ethers.ZeroHash, revokedClaimUid, revokedClaimEndorsementUid),
    ).to.be.revertedWith("ProposalNFT: Claim revoked");

    const validClaimUid = ethers.id("claim-valid-revoked-endorsement");
    const revokedEndorsementUid = ethers.id("endorsement-revoked");
    await setOwnershipAttestations({
      eas,
      claimUid: validClaimUid,
      endorsementUid: revokedEndorsementUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId: parcelTokenId(parcelId),
      claimant: accepter.address,
      lensMember: lensMember.address,
      endorsementRevocationTime: 1n,
    });

    await expect(
      proposalNFT.connect(accepter).acceptProposal(0, parcelId, ethers.ZeroHash, validClaimUid, revokedEndorsementUid),
    ).to.be.revertedWith("ProposalNFT: Endorsement revoked");
  });

  it("rejects malformed ownership targeting and endorsement metadata", async () => {
    const { proposalOwner, accepter, lensMember, outsider, parcelNFT, cityToken, eas, proposalNFT } =
      await loadFixture(deployProposalFixture);
    const parcelId = "HR-339318-7396";
    const tokenFunding = ethers.parseUnits("100", 18);
    const tokenId = parcelTokenId(parcelId);

    await parcelNFT.mintParcel(accepter.address, parcelId, "ipfs://parcel");
    await cityToken.connect(proposalOwner).approve(await proposalNFT.getAddress(), tokenFunding);
    await proposalNFT
      .connect(proposalOwner)
      .mintAndFund(proposalOwner.address, [parcelId], false, "ipfs://proposal", 0, tokenFunding, [lensMember.address]);

    const wrongRecipientClaimUid = ethers.id("claim-wrong-recipient");
    const wrongRecipientEndorsementUid = ethers.id("endorsement-wrong-recipient");
    await setOwnershipAttestations({
      eas,
      claimUid: wrongRecipientClaimUid,
      endorsementUid: wrongRecipientEndorsementUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId,
      claimant: accepter.address,
      lensMember: lensMember.address,
      claimRecipient: outsider.address,
    });

    await expect(
      proposalNFT
        .connect(accepter)
        .acceptProposal(0, parcelId, ethers.ZeroHash, wrongRecipientClaimUid, wrongRecipientEndorsementUid),
    ).to.be.revertedWith("ProposalNFT: Claim not targeted to caller");

    const wrongTargetClaimUid = ethers.id("claim-wrong-target-id");
    const wrongTargetEndorsementUid = ethers.id("endorsement-wrong-target-id");
    await setOwnershipAttestations({
      eas,
      claimUid: wrongTargetClaimUid,
      endorsementUid: wrongTargetEndorsementUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId,
      claimant: accepter.address,
      lensMember: lensMember.address,
      targetIdOverride: (tokenId + 1n).toString(),
    });

    await expect(
      proposalNFT.connect(accepter).acceptProposal(0, parcelId, ethers.ZeroHash, wrongTargetClaimUid, wrongTargetEndorsementUid),
    ).to.be.revertedWith("ProposalNFT: Wrong target id");

    const wrongRefClaimUid = ethers.id("claim-wrong-ref");
    const wrongRefEndorsementUid = ethers.id("endorsement-wrong-ref");
    await setOwnershipAttestations({
      eas,
      claimUid: wrongRefClaimUid,
      endorsementUid: wrongRefEndorsementUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId,
      claimant: accepter.address,
      lensMember: lensMember.address,
      endorsementRefUid: ethers.id("some-other-claim"),
    });

    await expect(
      proposalNFT.connect(accepter).acceptProposal(0, parcelId, ethers.ZeroHash, wrongRefClaimUid, wrongRefEndorsementUid),
    ).to.be.revertedWith("ProposalNFT: Endorsement ref mismatch");

    const wrongLensClaimUid = ethers.id("claim-endorser-not-in-lens");
    const wrongLensEndorsementUid = ethers.id("endorsement-not-in-lens");
    await setOwnershipAttestations({
      eas,
      claimUid: wrongLensClaimUid,
      endorsementUid: wrongLensEndorsementUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId,
      claimant: accepter.address,
      lensMember: lensMember.address,
      endorsementAttester: outsider.address,
    });

    await expect(
      proposalNFT.connect(accepter).acceptProposal(0, parcelId, ethers.ZeroHash, wrongLensClaimUid, wrongLensEndorsementUid),
    ).to.be.revertedWith("ProposalNFT: Endorser not in lens");

    const falseClaimUid = ethers.id("claim-endorsement-false");
    const falseEndorsementUid = ethers.id("endorsement-false");
    await setOwnershipAttestations({
      eas,
      claimUid: falseClaimUid,
      endorsementUid: falseEndorsementUid,
      parcelNFTAddress: await parcelNFT.getAddress(),
      tokenId,
      claimant: accepter.address,
      lensMember: lensMember.address,
      endorsementValue: false,
    });

    await expect(
      proposalNFT.connect(accepter).acceptProposal(0, parcelId, ethers.ZeroHash, falseClaimUid, falseEndorsementUid),
    ).to.be.revertedWith("ProposalNFT: Endorsement not true");
  });
});