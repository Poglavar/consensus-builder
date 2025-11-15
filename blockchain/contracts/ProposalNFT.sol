// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./ParcelNFT.sol";

contract ProposalNFT is ERC721Enumerable, Ownable {
    struct Proposal {
        string[] parcelIds;
        bool isConditional;
        string imageURI;
        bool isActive;
        uint256 ethBalance;
        uint256 tokenBalance;
        mapping(string => bool) hasAccepted;
        uint256 acceptanceCount;
    }

    ParcelNFT public parcelNFT;
    IERC20 public cityToken;
    IERC20 public usdcToken;
    mapping(uint256 => Proposal) public proposals;
    uint256 private _tokenIdCounter;

    event ProposalAccepted(uint256 indexed proposalId, string parcelId, address owner);
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
        newProposal.isActive = true;
        newProposal.ethBalance = ethAmount;
        newProposal.tokenBalance = tokenAmount;
        newProposal.acceptanceCount = 0;

        return tokenId;
    }

    function acceptProposal(uint256 proposalId, string memory parcelId) public {
        require(_ownerOf(proposalId) != address(0), "ProposalNFT: Proposal does not exist");
        require(proposals[proposalId].isActive, "ProposalNFT: Proposal is not active");

        // Verify parcel is part of the proposal
        bool isValidParcel = false;
        for (uint256 i = 0; i < proposals[proposalId].parcelIds.length; i++) {
            if (keccak256(bytes(proposals[proposalId].parcelIds[i])) == keccak256(bytes(parcelId))) {
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
        require(!proposals[proposalId].hasAccepted[parcelId], "ProposalNFT: Parcel already accepted");

        // Record acceptance
        proposals[proposalId].hasAccepted[parcelId] = true;
        proposals[proposalId].acceptanceCount++;

        emit ProposalAccepted(proposalId, parcelId, msg.sender);
    }

    // Function allowing anyone to contribute funds to a proposal.
    // tokenAddress can be 0 for ETH contribution or an ERC20 token address.
    function contributeFunds(uint256 proposalId, address tokenAddress, uint256 amount) public payable {
        require(_ownerOf(proposalId) != address(0), "ProposalNFT: Proposal does not exist");
        require(proposals[proposalId].isActive, "ProposalNFT: Proposal is not active");

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

    function distributeFunds(uint256 proposalId) public {
        require(_ownerOf(proposalId) != address(0), "ProposalNFT: Proposal does not exist");
        require(proposals[proposalId].isActive, "ProposalNFT: Proposal is not active");

        Proposal storage proposal = proposals[proposalId];

        if (proposal.isConditional) {
            require(proposal.acceptanceCount == proposal.parcelIds.length, "ProposalNFT: Not all parcels accepted");
        } else {
            require(proposal.acceptanceCount > 0, "ProposalNFT: No acceptances");
        }

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

        // Mark proposal as inactive after distribution
        proposal.isActive = false;

        emit FundsDistributed(proposalId, proposal.ethBalance, proposal.tokenBalance);
    }

    function getProposal(uint256 proposalId)
        public
        view
        returns (
            string[] memory parcelIds,
            bool isConditional,
            string memory imageURI,
            bool isActive,
            uint256 ethBalance,
            uint256 tokenBalance,
            uint256 acceptanceCount
        )
    {
        require(_ownerOf(proposalId) != address(0), "ProposalNFT: Proposal does not exist");
        Proposal storage proposal = proposals[proposalId];
        return (
            proposal.parcelIds,
            proposal.isConditional,
            proposal.imageURI,
            proposal.isActive,
            proposal.ethBalance,
            proposal.tokenBalance,
            proposal.acceptanceCount
        );
    }

    function hasAccepted(uint256 proposalId, string memory parcelId) public view returns (bool) {
        require(_ownerOf(proposalId) != address(0), "ProposalNFT: Proposal does not exist");
        return proposals[proposalId].hasAccepted[parcelId];
    }

    function tokenURI(uint256 tokenId) public view virtual override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "ProposalNFT: URI query for nonexistent token");
        return proposals[tokenId].imageURI;
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
