// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./ParcelNFT.sol";

contract ProposalNFT is ERC721Enumerable, Ownable {
    enum ProposalStatus {
        Active,
        Executed,
        Cancelled,
        Expired
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
        uint256 acceptanceCount;
        uint256 expiryTimestamp; // 0 means no expiry
        uint256 expiringPercentage; // Amount of reward that expires (not implemented yet)
    }

    ParcelNFT public parcelNFT;
    IERC20 public cityToken;
    IERC20 public usdcToken;
    mapping(uint256 => Proposal) public proposals;
    mapping(string => uint256[]) public parcelIdToProposals; // Reverse mapping: parcelId -> proposal IDs
    uint256 private _tokenIdCounter;

    event ProposalAccepted(uint256 indexed proposalId, string parcelId, address owner);
    event ProposalAcceptanceWithdrawn(uint256 indexed proposalId, string parcelId, address owner);
    event FundsContributed(uint256 indexed proposalId, address tokenAddress, uint256 amount);
    event FundsDistributed(uint256 indexed proposalId, uint256 ethAmount, uint256 tokenAmount);

    constructor(address _parcelNFTAddress, address _cityTokenAddress)
        ERC721("Urban Game Theory Proposal", "UGTR")
        Ownable(msg.sender)
    {
        parcelNFT = ParcelNFT(_parcelNFTAddress);
        cityToken = IERC20(_cityTokenAddress);
    }

    function mintAndFund(
        address to,
        string[] memory parcelIds,
        bool isConditional,
        string memory imageURI,
        uint256 ethAmount,
        uint256 tokenAmount
    ) public payable returns (uint256) {
        require(parcelIds.length > 0, "ProposalNFT: Must include at least one parcel");

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

        return tokenId;
    }

    function acceptProposal(uint256 proposalId, string memory parcelId) public {
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

        // Verify caller owns the parcel
        require(parcelNFT.ownerOf(parcelTokenId) == msg.sender, "ProposalNFT: Not parcel owner");

        // Check if parcel hasn't already accepted
        require(!proposal.hasAccepted[parcelId], "ProposalNFT: Parcel already accepted");

        // Record acceptance
        proposal.hasAccepted[parcelId] = true;
        proposal.acceptanceCount++;

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
    function withdrawAcceptance(uint256 proposalId, string memory parcelId) public {
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

        // Verify caller owns the parcel
        require(parcelNFT.ownerOf(parcelTokenId) == msg.sender, "ProposalNFT: Not parcel owner");

        // Check if parcel has accepted
        require(proposal.hasAccepted[parcelId], "ProposalNFT: Parcel has not accepted this proposal");

        // Withdraw acceptance
        proposal.hasAccepted[parcelId] = false;
        proposal.acceptanceCount--;

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
        // Note: Caller must ensure conditions are met (all accepted for conditional, at least one for non-conditional)
        uint256 ethPerParcel = proposal.ethBalance / proposal.acceptanceCount;
        uint256 tokensPerParcel = proposal.tokenBalance / proposal.acceptanceCount;

        // Distribute funds to accepting parcels
        for (uint256 i = 0; i < proposal.parcelIds.length; i++) {
            string memory parcelId = proposal.parcelIds[i];
            if (proposal.hasAccepted[parcelId]) {
                uint256 parcelTokenId = parcelNFT.tokenIdForParcelId(parcelId);
                address parcelOwner = parcelNFT.ownerOf(parcelTokenId);

                if (proposal.ethBalance > 0) {
                    (bool success,) = parcelOwner.call{value: ethPerParcel}("");
                    require(success, "ProposalNFT: ETH transfer failed");
                }

                if (proposal.tokenBalance > 0) {
                    require(cityToken.transfer(parcelOwner, tokensPerParcel), "ProposalNFT: Token transfer failed");
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

    function tokenURI(uint256 tokenId) public view virtual override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "ProposalNFT: URI query for nonexistent token");
        return proposals[tokenId].imageURI;
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
