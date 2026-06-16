import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

// Verifies the OffchainResolver accepts responses signed exactly the way
// backend/ens/gateway.js signs them (same makeSignatureHash construction).
describe("OffchainResolver", () => {
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const URL = "https://api.urbangametheory.xyz/ens/{sender}/{data}.json";
  const RESOLVE_SELECTOR = "0x9061b923"; // resolve(bytes,bytes)
  const TEXT_SELECTOR = "0x59d1d43c"; // text(bytes32,string)

  async function deployFixture() {
    const signer = ethers.Wallet.createRandom();
    const resolver = await ethers.deployContract("OffchainResolver", [URL, [signer.address]]);
    await resolver.waitForDeployment();
    return { resolver, signer };
  }

  // Build the wrapper calldata the resolver forwards: resolve(name, innerData).
  function buildCallData(nameNode: string, key: string) {
    const name = ethers.dnsEncode(nameNode);
    const inner = TEXT_SELECTOR + abi.encode(["bytes32", "string"], [ethers.namehash(nameNode), key]).slice(2);
    return RESOLVE_SELECTOR + abi.encode(["bytes", "bytes"], [name, inner]).slice(2);
  }

  // Mimic the gateway: produce a signed (result, expires, sig) response.
  async function signResponse(
    resolverAddr: string,
    signer: ethers.HDNodeWallet,
    callData: string,
    result: string,
    expires: number,
  ) {
    const hash = ethers.solidityPackedKeccak256(
      ["bytes2", "address", "uint64", "bytes32", "bytes32"],
      ["0x1900", resolverAddr, expires, ethers.keccak256(callData), ethers.keccak256(result)],
    );
    const sig = signer.signingKey.sign(hash).serialized;
    return abi.encode(["bytes", "uint64", "bytes"], [result, expires, sig]);
  }

  it("resolve() reverts with OffchainLookup pointing at the gateway", async () => {
    const { resolver } = await loadFixture(deployFixture);
    const name = ethers.dnsEncode("us-ny-1.parcels.urbangametheory.eth");
    const inner = TEXT_SELECTOR + abi.encode(["bytes32", "string"], [ethers.namehash("us-ny-1.parcels.urbangametheory.eth"), "url"]).slice(2);
    await expect(resolver.resolve(name, inner)).to.be.revertedWithCustomError(resolver, "OffchainLookup");
  });

  it("resolveWithProof accepts a gateway-signed response and returns the record", async () => {
    const { resolver, signer } = await loadFixture(deployFixture);
    const resolverAddr = await resolver.getAddress();
    const callData = buildCallData("us-ny-1.parcels.urbangametheory.eth", "url");
    const result = abi.encode(["string"], ["https://urbangametheory.xyz/parcel/US-NY-1"]);
    const expires = (await time.latest()) + 300;

    const response = await signResponse(resolverAddr, signer, callData, result, expires);
    const returned = await resolver.resolveWithProof(response, callData);
    const [url] = abi.decode(["string"], returned);
    expect(url).to.equal("https://urbangametheory.xyz/parcel/US-NY-1");
  });

  it("rejects a response signed by an untrusted signer", async () => {
    const { resolver } = await loadFixture(deployFixture);
    const resolverAddr = await resolver.getAddress();
    const rogue = ethers.Wallet.createRandom();
    const callData = buildCallData("us-ny-1.parcels.urbangametheory.eth", "url");
    const result = abi.encode(["string"], ["https://evil.example/x"]);
    const expires = (await time.latest()) + 300;

    const response = await signResponse(resolverAddr, rogue, callData, result, expires);
    await expect(resolver.resolveWithProof(response, callData)).to.be.revertedWith("OffchainResolver: invalid signature");
  });

  it("rejects an expired response", async () => {
    const { resolver, signer } = await loadFixture(deployFixture);
    const resolverAddr = await resolver.getAddress();
    const callData = buildCallData("us-ny-1.parcels.urbangametheory.eth", "url");
    const result = abi.encode(["string"], ["https://urbangametheory.xyz/parcel/US-NY-1"]);
    const expires = (await time.latest()) - 1; // already expired

    const response = await signResponse(resolverAddr, signer, callData, result, expires);
    await expect(resolver.resolveWithProof(response, callData)).to.be.revertedWith("SignatureVerifier: Signature expired");
  });

  it("owner can add a signer", async () => {
    const { resolver } = await loadFixture(deployFixture);
    const extra = ethers.Wallet.createRandom();
    await resolver.setSigner(extra.address, true);
    expect(await resolver.signers(extra.address)).to.equal(true);
  });
});

// Option B: the apex names resolve on-chain (records set by the owner), while
// wildcard children still fall through to the gateway.
describe("OffchainResolver — on-chain apex records (hybrid)", () => {
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const URL = "https://api.urbangametheory.xyz/ens/{sender}/{data}.json";
  const ADDR_SELECTOR = "0x3b3b57de";
  const TEXT_SELECTOR = "0x59d1d43c";
  const CONTRACT = "0x191Bb541E185f8C4fBF1eF4CE12a28acCFA6b35d";
  const NAME = "parcels.urbangametheory.eth";

  async function deployFixture() {
    const signer = ethers.Wallet.createRandom();
    const resolver = await ethers.deployContract("OffchainResolver", [URL, [signer.address]]);
    await resolver.waitForDeployment();
    return { resolver };
  }

  it("returns an on-chain addr inline (direct getter and via resolve)", async () => {
    const { resolver } = await loadFixture(deployFixture);
    const node = ethers.namehash(NAME);
    await (await resolver["setAddr(bytes32,address)"](node, CONTRACT)).wait();

    expect(await resolver["addr(bytes32)"](node)).to.equal(CONTRACT);

    const name = ethers.dnsEncode(NAME);
    const inner = ADDR_SELECTOR + abi.encode(["bytes32"], [node]).slice(2);
    const out = await resolver.resolve(name, inner);
    expect(abi.decode(["address"], out)[0]).to.equal(CONTRACT);
  });

  it("returns an on-chain text record inline", async () => {
    const { resolver } = await loadFixture(deployFixture);
    const node = ethers.namehash(NAME);
    await (await resolver.setText(node, "description", "Urban Game Theory parcels")).wait();
    expect(await resolver.text(node, "description")).to.equal("Urban Game Theory parcels");

    const name = ethers.dnsEncode(NAME);
    const inner = TEXT_SELECTOR + abi.encode(["bytes32", "string"], [node, "description"]).slice(2);
    const out = await resolver.resolve(name, inner);
    expect(abi.decode(["string"], out)[0]).to.equal("Urban Game Theory parcels");
  });

  it("still reverts OffchainLookup for child nodes (no on-chain record)", async () => {
    const { resolver } = await loadFixture(deployFixture);
    const child = "us-ny-1.parcels.urbangametheory.eth";
    const name = ethers.dnsEncode(child);
    const inner = ADDR_SELECTOR + abi.encode(["bytes32"], [ethers.namehash(child)]).slice(2);
    await expect(resolver.resolve(name, inner)).to.be.revertedWithCustomError(resolver, "OffchainLookup");
  });

  it("advertises addr / text / extended-resolver interfaces", async () => {
    const { resolver } = await loadFixture(deployFixture);
    expect(await resolver.supportsInterface("0x3b3b57de")).to.equal(true); // addr
    expect(await resolver.supportsInterface("0x59d1d43c")).to.equal(true); // text
    expect(await resolver.supportsInterface("0x9061b923")).to.equal(true); // IExtendedResolver
  });

  it("only the owner can set records", async () => {
    const { resolver } = await loadFixture(deployFixture);
    const [, other] = await ethers.getSigners();
    const node = ethers.namehash(NAME);
    await expect(resolver.connect(other)["setAddr(bytes32,address)"](node, CONTRACT))
      .to.be.revertedWith("OffchainResolver: not owner");
  });
});
