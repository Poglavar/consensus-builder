// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "./ParcelNFT.sol";

interface IEAS {
    struct Attestation {
        bytes32 uid;
        bytes32 schema;
        uint64 time;
        uint64 expirationTime;
        uint64 revocationTime;
        bytes32 refUID;
        address recipient;
        address attester;
        bool revocable;
        bytes data;
    }

    function getAttestation(bytes32 uid) external view returns (Attestation memory);
}

contract ProposalNFT is ERC721Enumerable, Ownable {
    enum ProposalStatus {
        Active,
        Executed,
        Cancelled,
        Expired
    }

    struct OwnerEntry {
        string name;
        address owner;
        string dptoNumber;
        uint256 shareBps;
    }

    struct ParcelOwnerState {
        bool usesOwnerList;
        bytes32 ownerListUid;
        address[] owners;
        mapping(address => uint256) shareBps;
        mapping(address => bool) accepted;
        uint256 ownersAccepted;
        uint256 totalShareBps;
    }

    struct Proposal {
        string[] parcelIds;
        bool isConditional;
        string imageURI;
        bool acceptancePossible;
        ProposalStatus status;
        uint256 ethBalance;
        uint256 tokenBalance;
        mapping(string => bool) hasAccepted;
        mapping(string => address) acceptedBy;
        mapping(string => ParcelOwnerState) parcelOwners;
        address[] lens;
        mapping(address => bool) isLens;
        uint256 acceptanceCount;
        uint256 expiryTimestamp; // 0 means no expiry
        uint256 expiringPercentage; // Amount of reward that expires (not implemented yet)
    }

    ParcelNFT public parcelNFT;
    IERC20 public cityToken;
    IERC20 public usdcToken;
    IEAS public eas;
    bytes32 public immutable ownThisSchemaUid;
    bytes32 public immutable endorsementSchemaUid;
    bytes32 public immutable ownerListSchemaUid;
    uint256 private constant FULL_SHARE_BPS = 10_000;
    mapping(uint256 => Proposal) public proposals;
    mapping(string => uint256[]) public parcelIdToProposals; // Reverse mapping: parcelId -> proposal IDs
    uint256 private _tokenIdCounter;

    event ProposalAccepted(uint256 indexed proposalId, string parcelId, address owner);
    event ProposalAcceptanceWithdrawn(uint256 indexed proposalId, string parcelId, address owner);
    event FundsContributed(uint256 indexed proposalId, address tokenAddress, uint256 amount);
    event FundsDistributed(uint256 indexed proposalId, uint256 ethAmount, uint256 tokenAmount);

    constructor(
        address _parcelNFTAddress,
        address _cityTokenAddress,
        address _easAddress,
        bytes32 _ownThisSchemaUid,
        bytes32 _endorsementSchemaUid,
        bytes32 _ownerListSchemaUid
    )
        ERC721("Urban Game Theory Proposal", "UGTR")
        Ownable(msg.sender)
    {
        parcelNFT = ParcelNFT(_parcelNFTAddress);
        cityToken = IERC20(_cityTokenAddress);
        eas = IEAS(_easAddress);
        ownThisSchemaUid = _ownThisSchemaUid;
        endorsementSchemaUid = _endorsementSchemaUid;
        ownerListSchemaUid = _ownerListSchemaUid;
    }

    function mintAndFund(
        address to,
        string[] memory parcelIds,
        bool isConditional,
        string memory imageURI,
        uint256 ethAmount,
        uint256 tokenAmount,
        address[] memory lens
    ) public payable returns (uint256) {
        require(parcelIds.length > 0, "ProposalNFT: Must include at least one parcel");
        require(lens.length > 0, "ProposalNFT: Must include at least one lens address");

        if (ethAmount > 0) {
            require(msg.value == ethAmount, "ProposalNFT: ETH amount mismatch");
        }
        if (tokenAmount > 0) {
            require(
                cityToken.allowance(msg.sender, address(this)) >= tokenAmount,
                "ProposalNFT: Token allowance insufficient"
            );
            require(
                cityToken.transferFrom(msg.sender, address(this), tokenAmount), "ProposalNFT: Token transfer failed"
            );
        }

        uint256 tokenId = _tokenIdCounter;
        _tokenIdCounter++;

        _safeMint(to, tokenId);

        Proposal storage newProposal = proposals[tokenId];
        newProposal.parcelIds = parcelIds;
        newProposal.isConditional = isConditional;
        newProposal.imageURI = imageURI;
        newProposal.acceptancePossible = true;
        newProposal.status = ProposalStatus.Active;
        newProposal.ethBalance = ethAmount;
        newProposal.tokenBalance = tokenAmount;
        newProposal.acceptanceCount = 0;
        newProposal.expiryTimestamp = 0; // Default: no expiry
        newProposal.expiringPercentage = 0; // Not implemented yet

        // Populate reverse mapping: add this proposal to each parcel's proposal list
        for (uint256 i = 0; i < parcelIds.length; i++) {
            parcelIdToProposals[parcelIds[i]].push(tokenId);
        }

        // Store lens members for this proposal
        for (uint256 i = 0; i < lens.length; i++) {
            address lensMember = lens[i];
            require(lensMember != address(0), "ProposalNFT: Invalid lens address");
            require(!newProposal.isLens[lensMember], "ProposalNFT: Duplicate lens address");
            newProposal.isLens[lensMember] = true;
            newProposal.lens.push(lensMember);
        }

        return tokenId;
    }

    function acceptProposal(
        uint256 proposalId,
        string memory parcelId,
        bytes32 ownerListUid,
        bytes32 claimUid,
        bytes32 endorsementUid
    ) public {
        require(_ownerOf(proposalId) != address(0), "ProposalNFT: Proposal does not exist");
        Proposal storage proposal = proposals[proposalId];

        require(proposal.acceptancePossible, "ProposalNFT: Proposal acceptance is not possible");

        // Check if proposal is expired
        if (proposal.expiryTimestamp > 0 && block.timestamp >= proposal.expiryTimestamp) {
            proposal.status = ProposalStatus.Expired;
            proposal.acceptancePossible = false;
            revert("ProposalNFT: Proposal has expired");
        }

        // Verify parcel is part of the proposal
        bool isValidParcel = false;
        for (uint256 i = 0; i < proposal.parcelIds.length; i++) {
            if (keccak256(bytes(proposal.parcelIds[i])) == keccak256(bytes(parcelId))) {
                isValidParcel = true;
                break;
            }
        }
        require(isValidParcel, "ProposalNFT: Parcel not part of proposal");

        // Resolve parcel NFT token id from the external parcel identifier
        uint256 parcelTokenId = parcelNFT.tokenIdForParcelId(parcelId);

        bool wasParcelAccepted = proposal.hasAccepted[parcelId];

        if (ownerListUid != bytes32(0)) {
            _acceptWithOwnerList(
                proposal, parcelId, parcelTokenId, ownerListUid, claimUid, endorsementUid, msg.sender, wasParcelAccepted
            );
        } else {
            // Verify caller is attested owner via claim + lens endorsement
            _validateOwnershipAttestations(proposal, parcelTokenId, claimUid, endorsementUid, msg.sender);

            // Check if parcel hasn't already accepted
            require(!proposal.hasAccepted[parcelId], "ProposalNFT: Parcel already accepted");

            proposal.hasAccepted[parcelId] = true;
            proposal.acceptedBy[parcelId] = msg.sender;
            proposal.acceptanceCount++;
        }

        emit ProposalAccepted(proposalId, parcelId, msg.sender);

        // Check if all parcels have accepted
        if (proposal.acceptanceCount == proposal.parcelIds.length) {
            proposal.acceptancePossible = false;
            proposal.status = ProposalStatus.Executed;
            _distributeFunds(proposalId);
        }
    }

    /**
     * @dev Withdraw acceptance of a proposal by a parcel owner
     * @param proposalId The proposal ID
     * @param parcelId The parcel ID to withdraw acceptance for
     * @notice Only works for conditional proposals that are active and not executed/expired
     * @notice Non-conditional proposals cannot withdraw acceptance
     */
    function withdrawAcceptance(
        uint256 proposalId,
        string memory parcelId,
        bytes32 ownerListUid,
        bytes32 claimUid,
        bytes32 endorsementUid
    ) public {
        require(_ownerOf(proposalId) != address(0), "ProposalNFT: Proposal does not exist");
        Proposal storage proposal = proposals[proposalId];

        // Only conditional proposals can have acceptance withdrawn
        require(proposal.isConditional, "ProposalNFT: Cannot withdraw acceptance from non-conditional proposal");

        // Proposal must be active (not executed, expired, or cancelled)
        require(proposal.status == ProposalStatus.Active, "ProposalNFT: Proposal is not active");
        require(proposal.acceptancePossible, "ProposalNFT: Proposal acceptance is not possible");

        // Verify parcel is part of the proposal
        bool isValidParcel = false;
        for (uint256 i = 0; i < proposal.parcelIds.length; i++) {
            if (keccak256(bytes(proposal.parcelIds[i])) == keccak256(bytes(parcelId))) {
                isValidParcel = true;
                break;
            }
        }
        require(isValidParcel, "ProposalNFT: Parcel not part of proposal");

        // Resolve parcel NFT token id from the external parcel identifier
        uint256 parcelTokenId = parcelNFT.tokenIdForParcelId(parcelId);

        if (ownerListUid != bytes32(0)) {
            _withdrawWithOwnerList(
                proposal, parcelId, parcelTokenId, ownerListUid, claimUid, endorsementUid, msg.sender
            );
        } else {
            // Verify caller was the attested owner who accepted
            require(proposal.acceptedBy[parcelId] == msg.sender, "ProposalNFT: Caller did not accept");
            _validateOwnershipAttestations(proposal, parcelTokenId, claimUid, endorsementUid, msg.sender);

            // Check if parcel has accepted
            require(proposal.hasAccepted[parcelId], "ProposalNFT: Parcel has not accepted this proposal");

            // Withdraw acceptance
            proposal.hasAccepted[parcelId] = false;
            proposal.acceptedBy[parcelId] = address(0);
            proposal.acceptanceCount--;
        }

        emit ProposalAcceptanceWithdrawn(proposalId, parcelId, msg.sender);
    }

    // Function allowing anyone to contribute funds to a proposal.
    // tokenAddress can be 0 for ETH contribution or an ERC20 token address.
    function contributeFunds(uint256 proposalId, address tokenAddress, uint256 amount) public payable {
        require(_ownerOf(proposalId) != address(0), "ProposalNFT: Proposal does not exist");
        require(proposals[proposalId].acceptancePossible, "ProposalNFT: Proposal acceptance is not possible");

        if (tokenAddress != address(0)) {
            // We are dealing with an ERC20 token
            require(
                IERC20(tokenAddress).transferFrom(msg.sender, address(this), amount),
                "ProposalNFT: Token transfer failed"
            );
        } else {
            // We are dealing with ETH
            require(msg.value == amount, "ProposalNFT: ETH amount mismatch");
            proposals[proposalId].ethBalance += amount;
        }

        emit FundsContributed(proposalId, tokenAddress, amount);
    }

    function _distributeFunds(uint256 proposalId) internal {
        Proposal storage proposal = proposals[proposalId];

        // Distribute proportional reward to each person that accepted
        uint256 totalShares = _totalAcceptedShares(proposal);
        require(totalShares > 0, "ProposalNFT: No shares to distribute");
        uint256 ethPerShare = proposal.ethBalance / totalShares;
        uint256 tokensPerShare = proposal.tokenBalance / totalShares;

        // Distribute funds to accepting parcels
        for (uint256 i = 0; i < proposal.parcelIds.length; i++) {
            string memory parcelId = proposal.parcelIds[i];
            if (proposal.hasAccepted[parcelId]) {
                ParcelOwnerState storage pos = proposal.parcelOwners[parcelId];
                if (pos.usesOwnerList) {
                    _payOwnerList(pos, ethPerShare, tokensPerShare);
                } else {
                    address recipient = proposal.acceptedBy[parcelId];
                    require(recipient != address(0), "ProposalNFT: Missing acceptance recipient");

                    if (proposal.ethBalance > 0) {
                        (bool success,) = recipient.call{value: ethPerShare * FULL_SHARE_BPS}("");
                        require(success, "ProposalNFT: ETH transfer failed");
                    }

                    if (proposal.tokenBalance > 0) {
                        require(
                            cityToken.transfer(recipient, tokensPerShare * FULL_SHARE_BPS),
                            "ProposalNFT: Token transfer failed"
                        );
                    }
                }
            }
        }

        emit FundsDistributed(proposalId, proposal.ethBalance, proposal.tokenBalance);
    }

    function _returnFundsToOwner(uint256 proposalId) internal {
        Proposal storage proposal = proposals[proposalId];
        address proposalOwner = _ownerOf(proposalId);

        // Return ETH to proposal owner
        if (proposal.ethBalance > 0) {
            (bool success,) = proposalOwner.call{value: proposal.ethBalance}("");
            require(success, "ProposalNFT: ETH transfer failed");
        }

        // Return tokens to proposal owner
        if (proposal.tokenBalance > 0) {
            require(cityToken.transfer(proposalOwner, proposal.tokenBalance), "ProposalNFT: Token transfer failed");
        }

        emit FundsDistributed(proposalId, proposal.ethBalance, proposal.tokenBalance);
    }

    function distributeFunds(uint256 proposalId) public {
        require(_ownerOf(proposalId) != address(0), "ProposalNFT: Proposal does not exist");

        Proposal storage proposal = proposals[proposalId];
        address proposalOwner = _ownerOf(proposalId);
        bool isOwner = msg.sender == proposalOwner;

        // Handle expired proposals - anyone can return funds to owner
        if (proposal.expiryTimestamp > 0 && block.timestamp >= proposal.expiryTimestamp) {
            require(
                proposal.status == ProposalStatus.Expired || proposal.status == ProposalStatus.Active,
                "ProposalNFT: Proposal already processed"
            );
            proposal.status = ProposalStatus.Expired;
            proposal.acceptancePossible = false;
            _returnFundsToOwner(proposalId);
            return;
        }

        // Handle cancellation - owner can cancel non-executed proposals
        if (isOwner && proposal.status != ProposalStatus.Executed) {
            require(proposal.status == ProposalStatus.Active, "ProposalNFT: Proposal already processed");
            proposal.status = ProposalStatus.Cancelled;
            proposal.acceptancePossible = false;
            _returnFundsToOwner(proposalId);
            return;
        }

        // Handle executed proposals - distribute to accepting parcel owners
        require(proposal.status == ProposalStatus.Executed, "ProposalNFT: Proposal must be executed");

        if (proposal.isConditional) {
            require(proposal.acceptanceCount == proposal.parcelIds.length, "ProposalNFT: Not all parcels accepted");
        } else {
            require(proposal.acceptanceCount > 0, "ProposalNFT: No acceptances");
        }

        _distributeFunds(proposalId);
    }

    function getProposal(uint256 proposalId)
        public
        view
        returns (
            string[] memory parcelIds,
            bool isConditional,
            string memory imageURI,
            bool acceptancePossible,
            ProposalStatus status,
            uint256 ethBalance,
            uint256 tokenBalance,
            uint256 acceptanceCount,
            uint256 expiryTimestamp,
            uint256 expiringPercentage
        )
    {
        require(_ownerOf(proposalId) != address(0), "ProposalNFT: Proposal does not exist");
        Proposal storage proposal = proposals[proposalId];
        return (
            proposal.parcelIds,
            proposal.isConditional,
            proposal.imageURI,
            proposal.acceptancePossible,
            proposal.status,
            proposal.ethBalance,
            proposal.tokenBalance,
            proposal.acceptanceCount,
            proposal.expiryTimestamp,
            proposal.expiringPercentage
        );
    }

    function getLens(uint256 proposalId) public view returns (address[] memory) {
        require(_ownerOf(proposalId) != address(0), "ProposalNFT: Proposal does not exist");
        return proposals[proposalId].lens;
    }

    function hasAccepted(uint256 proposalId, string memory parcelId) public view returns (bool) {
        require(_ownerOf(proposalId) != address(0), "ProposalNFT: Proposal does not exist");
        return proposals[proposalId].hasAccepted[parcelId];
    }

    /**
     * @dev Get all proposal IDs that include a specific parcel
     * @param parcelId The parcel ID to query
     * @return An array of proposal token IDs that include this parcel
     */
    function getProposalsForParcel(string memory parcelId) public view returns (uint256[] memory) {
        return parcelIdToProposals[parcelId];
    }

    /**
     * @dev Get proposals for a parcel with acceptance status (more efficient than multiple calls)
     * @param parcelId The parcel ID to query
     * @return proposalIds Array of proposal token IDs
     * @return acceptanceStatus Array of booleans indicating if parcel has accepted each proposal
     */
    function getProposalsForParcelWithStatus(string memory parcelId) 
        public 
        view 
        returns (uint256[] memory proposalIds, bool[] memory acceptanceStatus) 
    {
        proposalIds = parcelIdToProposals[parcelId];
        acceptanceStatus = new bool[](proposalIds.length);
        
        for (uint256 i = 0; i < proposalIds.length; i++) {
            acceptanceStatus[i] = proposals[proposalIds[i]].hasAccepted[parcelId];
        }
    }

    /**
     * @dev Batch get multiple proposals at once (more efficient than individual calls)
     * @param proposalIds Array of proposal IDs to fetch
     * @return parcelIdsArray Array of parcel IDs per proposal
     * @return isConditionalArray Whether each proposal is conditional
     * @return imageURIArray Image URI for each proposal
     * @return acceptancePossibleArray Whether acceptance is currently possible
     * @return statusArray Current status for each proposal
     * @return ethBalanceArray ETH balance locked for each proposal
     * @return tokenBalanceArray Token balance locked for each proposal
     * @return acceptanceCountArray Number of acceptances per proposal
     * @return expiryTimestampArray Expiration timestamp per proposal
     * @return expiringPercentageArray Percentage-progress toward expiry per proposal
     */
    function getProposalsBatch(uint256[] memory proposalIds) 
        public 
        view 
        returns (
            string[][] memory parcelIdsArray,
            bool[] memory isConditionalArray,
            string[] memory imageURIArray,
            bool[] memory acceptancePossibleArray,
            ProposalStatus[] memory statusArray,
            uint256[] memory ethBalanceArray,
            uint256[] memory tokenBalanceArray,
            uint256[] memory acceptanceCountArray,
            uint256[] memory expiryTimestampArray,
            uint256[] memory expiringPercentageArray
        )
    {
        uint256 length = proposalIds.length;
        parcelIdsArray = new string[][](length);
        isConditionalArray = new bool[](length);
        imageURIArray = new string[](length);
        acceptancePossibleArray = new bool[](length);
        statusArray = new ProposalStatus[](length);
        ethBalanceArray = new uint256[](length);
        tokenBalanceArray = new uint256[](length);
        acceptanceCountArray = new uint256[](length);
        expiryTimestampArray = new uint256[](length);
        expiringPercentageArray = new uint256[](length);

        for (uint256 i = 0; i < length; i++) {
            require(_ownerOf(proposalIds[i]) != address(0), "ProposalNFT: Proposal does not exist");
            Proposal storage proposal = proposals[proposalIds[i]];
            parcelIdsArray[i] = proposal.parcelIds;
            isConditionalArray[i] = proposal.isConditional;
            imageURIArray[i] = proposal.imageURI;
            acceptancePossibleArray[i] = proposal.acceptancePossible;
            statusArray[i] = proposal.status;
            ethBalanceArray[i] = proposal.ethBalance;
            tokenBalanceArray[i] = proposal.tokenBalance;
            acceptanceCountArray[i] = proposal.acceptanceCount;
            expiryTimestampArray[i] = proposal.expiryTimestamp;
            expiringPercentageArray[i] = proposal.expiringPercentage;
        }
    }

    /**
     * @dev Get all proposal token IDs owned by a specific address
     * @param owner The address to query
     * @return An array of proposal token IDs owned by the address
     */
    function getTokensByOwner(address owner) public view returns (uint256[] memory) {
        uint256 balance = balanceOf(owner);
        uint256[] memory tokens = new uint256[](balance);
        for (uint256 i = 0; i < balance; i++) {
            tokens[i] = tokenOfOwnerByIndex(owner, i);
        }
        return tokens;
    }

    function tokenURI(uint256 tokenId) public view virtual override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "ProposalNFT: URI query for nonexistent token");
        return proposals[tokenId].imageURI;
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _validateOwnershipAttestations(
        Proposal storage proposal,
        uint256 parcelTokenId,
        bytes32 claimUid,
        bytes32 endorsementUid,
        address caller
    ) internal view {
        // Step 1: claimant self-attests ownership
        IEAS.Attestation memory claim = eas.getAttestation(claimUid);
        require(claim.attester != address(0), "ProposalNFT: Claim not found");
        require(claim.schema == ownThisSchemaUid, "ProposalNFT: Invalid claim schema");
        require(claim.attester == caller, "ProposalNFT: Claim not signed by caller");
        require(claim.recipient == caller, "ProposalNFT: Claim not targeted to caller");
        require(claim.revocationTime == 0, "ProposalNFT: Claim revoked");
        require(claim.expirationTime == 0 || claim.expirationTime > block.timestamp, "ProposalNFT: Claim expired");

        (
            string memory iOwnThisLabel,
            string memory targetChain,
            string memory targetAddress,
            string memory targetId
        ) = abi.decode(claim.data, (string, string, string, string));

        // Optional sanity check on label
        require(bytes(iOwnThisLabel).length != 0, "ProposalNFT: Claim label empty");

        // Check target chain/address/id match this contract's parcel token id
        string memory expectedChain = Strings.toString(block.chainid);
        require(
            keccak256(bytes(targetChain)) == keccak256(bytes(expectedChain)),
            "ProposalNFT: Wrong target chain"
        );

        string memory expectedAddress = Strings.toHexString(uint160(address(parcelNFT)), 20);
        require(
            keccak256(bytes(targetAddress)) == keccak256(bytes(expectedAddress)),
            "ProposalNFT: Wrong target address"
        );

        string memory expectedTokenId = Strings.toString(parcelTokenId);
        require(
            keccak256(bytes(targetId)) == keccak256(bytes(expectedTokenId)),
            "ProposalNFT: Wrong target id"
        );

        // Step 2: lens endorsement of the claim
        IEAS.Attestation memory endorsement = eas.getAttestation(endorsementUid);
        require(endorsement.attester != address(0), "ProposalNFT: Endorsement not found");
        require(endorsement.schema == endorsementSchemaUid, "ProposalNFT: Invalid endorsement schema");
        require(proposal.isLens[endorsement.attester], "ProposalNFT: Endorser not in lens");
        require(endorsement.refUID == claimUid, "ProposalNFT: Endorsement ref mismatch");
        require(endorsement.recipient == caller, "ProposalNFT: Endorsement not for caller");
        require(endorsement.revocationTime == 0, "ProposalNFT: Endorsement revoked");
        require(
            endorsement.expirationTime == 0 || endorsement.expirationTime > block.timestamp,
            "ProposalNFT: Endorsement expired"
        );

        bool isTrue = abi.decode(endorsement.data, (bool));
        require(isTrue, "ProposalNFT: Endorsement not true");
    }

    function _acceptWithOwnerList(
        Proposal storage proposal,
        string memory parcelId,
        uint256 parcelTokenId,
        bytes32 ownerListUid,
        bytes32 claimUid,
        bytes32 endorsementUid,
        address caller,
        bool wasParcelAccepted
    ) internal {
        ParcelOwnerState storage pos = proposal.parcelOwners[parcelId];
        if (!pos.usesOwnerList) {
            _initOwnerList(proposal, pos, parcelTokenId, ownerListUid);
        } else {
            require(pos.ownerListUid == ownerListUid, "ProposalNFT: owner list UID mismatch");
        }

        _validateOwnershipAttestations(proposal, parcelTokenId, claimUid, endorsementUid, caller);

        require(pos.shareBps[caller] > 0, "ProposalNFT: Caller not in owner list");
        require(!pos.accepted[caller], "ProposalNFT: Owner already accepted");

        pos.accepted[caller] = true;
        pos.ownersAccepted++;

        if (pos.ownersAccepted == pos.owners.length && !wasParcelAccepted) {
            proposal.hasAccepted[parcelId] = true;
            proposal.acceptanceCount++;
        }
    }

    function _withdrawWithOwnerList(
        Proposal storage proposal,
        string memory parcelId,
        uint256 parcelTokenId,
        bytes32 ownerListUid,
        bytes32 claimUid,
        bytes32 endorsementUid,
        address caller
    ) internal {
        ParcelOwnerState storage pos = proposal.parcelOwners[parcelId];
        require(pos.usesOwnerList, "ProposalNFT: Parcel not using owner list");
        require(pos.ownerListUid == ownerListUid, "ProposalNFT: owner list UID mismatch");

        _validateOwnershipAttestations(proposal, parcelTokenId, claimUid, endorsementUid, caller);

        require(pos.accepted[caller], "ProposalNFT: Owner did not accept");

        bool parcelWasAccepted = proposal.hasAccepted[parcelId];

        pos.accepted[caller] = false;
        pos.ownersAccepted--;

        if (parcelWasAccepted && pos.ownersAccepted < pos.owners.length) {
            proposal.hasAccepted[parcelId] = false;
            proposal.acceptanceCount--;
        }
    }

    function _initOwnerList(
        Proposal storage proposal,
        ParcelOwnerState storage pos,
        uint256 parcelTokenId,
        bytes32 ownerListUid
    ) internal {
        IEAS.Attestation memory att = eas.getAttestation(ownerListUid);
        require(att.attester != address(0), "ProposalNFT: Owner list not found");
        require(att.schema == ownerListSchemaUid, "ProposalNFT: Invalid owner list schema");
        require(proposal.isLens[att.attester], "ProposalNFT: Owner list attester not in lens");
        require(att.revocationTime == 0, "ProposalNFT: Owner list revoked");
        require(att.expirationTime == 0 || att.expirationTime > block.timestamp, "ProposalNFT: Owner list expired");

        (string memory targetChain, string memory targetContract, string memory targetId, OwnerEntry[] memory owners) =
            abi.decode(att.data, (string, string, string, OwnerEntry[]));

        require(keccak256(bytes(targetChain)) == keccak256(bytes(Strings.toString(block.chainid))), "ProposalNFT: Owner list wrong chain");
        require(
            keccak256(bytes(targetContract)) == keccak256(bytes(Strings.toHexString(uint160(address(parcelNFT)), 20))),
            "ProposalNFT: Owner list wrong contract"
        );
        require(keccak256(bytes(targetId)) == keccak256(bytes(Strings.toString(parcelTokenId))), "ProposalNFT: Owner list wrong token");
        require(owners.length > 0, "ProposalNFT: Empty owner list");

        uint256 totalShare;
        for (uint256 i = 0; i < owners.length; i++) {
            address ownerAddr = owners[i].owner;
            uint256 share = owners[i].shareBps;
            require(ownerAddr != address(0), "ProposalNFT: Invalid owner address");
            require(share > 0, "ProposalNFT: Owner share zero");
            require(pos.shareBps[ownerAddr] == 0, "ProposalNFT: Duplicate owner");
            pos.shareBps[ownerAddr] = share;
            pos.owners.push(ownerAddr);
            totalShare += share;
        }
        require(totalShare > 0, "ProposalNFT: Total share zero");

        pos.usesOwnerList = true;
        pos.ownerListUid = ownerListUid;
        pos.totalShareBps = totalShare;
    }

    function _totalAcceptedShares(Proposal storage proposal) internal view returns (uint256 totalShares) {
        for (uint256 i = 0; i < proposal.parcelIds.length; i++) {
            string memory parcelId = proposal.parcelIds[i];
            if (proposal.hasAccepted[parcelId]) {
                ParcelOwnerState storage pos = proposal.parcelOwners[parcelId];
                if (pos.usesOwnerList) {
                    totalShares += pos.totalShareBps;
                } else {
                    totalShares += FULL_SHARE_BPS;
                }
            }
        }
    }

    function _payOwnerList(ParcelOwnerState storage pos, uint256 ethPerShare, uint256 tokensPerShare) internal {
        for (uint256 i = 0; i < pos.owners.length; i++) {
            address ownerAddr = pos.owners[i];
            require(pos.accepted[ownerAddr], "ProposalNFT: Owner missing acceptance");
            uint256 share = pos.shareBps[ownerAddr];
            if (ethPerShare > 0) {
                uint256 ethAmount = ethPerShare * share;
                (bool success,) = ownerAddr.call{value: ethAmount}("");
                require(success, "ProposalNFT: ETH transfer failed");
            }
            if (tokensPerShare > 0) {
                uint256 tokenAmount = tokensPerShare * share;
                require(cityToken.transfer(ownerAddr, tokenAmount), "ProposalNFT: Token transfer failed");
            }
        }
    }
}
