// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

interface IOracleVoteTarget {
    function reportOracleOwner(uint256 proposalId, bytes32 ownerId) external;
    function reportOracleVote(uint256 proposalId, bytes32 ownerId, uint8 choice, bytes32 evidenceHash) external;
}

/**
 * @dev A provider-specific reporter instance. The owner controls which service wallets can
 *      report facts. The proposal contract independently checks that this very contract was
 *      selected at mint time. Deploy separate instances for independent data providers.
 */
contract OracleReporter is Ownable {
    IOracleVoteTarget public immutable proposalContract;
    mapping(address => bool) public reporters;
    mapping(bytes32 => bool) public approvedElectorate;
    mapping(uint256 => mapping(bytes32 => address)) public voterWallet;
    mapping(uint256 => mapping(address => bytes32)) public walletOwnerId;

    event ReporterChanged(address indexed reporter, bool enabled);
    event ElectorateApproved(bytes32 indexed commitment);
    event ElectorateRevoked(bytes32 indexed commitment);
    event VoterWalletBound(uint256 indexed proposalId, bytes32 indexed ownerId, address indexed wallet);
    event WalletVote(uint256 indexed proposalId, bytes32 indexed ownerId, address indexed wallet, uint8 choice);

    constructor(address proposalContractAddress) Ownable(msg.sender) {
        require(proposalContractAddress != address(0), "OracleReporter: Missing proposal contract");
        proposalContract = IOracleVoteTarget(proposalContractAddress);
    }

    modifier onlyReporter() {
        require(reporters[msg.sender], "OracleReporter: Not a reporter");
        _;
    }

    function setReporter(address reporter, bool enabled) external onlyOwner {
        require(reporter != address(0), "OracleReporter: Invalid reporter");
        reporters[reporter] = enabled;
        emit ReporterChanged(reporter, enabled);
    }

    function reportAcceptedOwner(uint256 proposalId, bytes32 ownerId) external onlyReporter {
        proposalContract.reportOracleOwner(proposalId, ownerId);
    }

    function approveElectorate(bytes32 commitment) external onlyReporter {
        require(commitment != bytes32(0), "OracleReporter: Invalid commitment");
        approvedElectorate[commitment] = true;
        emit ElectorateApproved(commitment);
    }

    function revokeElectorate(bytes32 commitment) external onlyReporter {
        delete approvedElectorate[commitment];
        emit ElectorateRevoked(commitment);
    }

    function reportVote(uint256 proposalId, bytes32 ownerId, uint8 choice, bytes32 evidenceHash) external onlyReporter {
        proposalContract.reportOracleVote(proposalId, ownerId, choice, evidenceHash);
    }

    /** @dev Bind a verified person to a wallet after the provider has authenticated them. */
    function bindVoterWallet(uint256 proposalId, bytes32 ownerId, address wallet) external onlyReporter {
        require(ownerId != bytes32(0) && wallet != address(0), "OracleReporter: Invalid voter");
        require(walletOwnerId[proposalId][wallet] == bytes32(0) || walletOwnerId[proposalId][wallet] == ownerId,
            "OracleReporter: Wallet already bound");
        address previousWallet = voterWallet[proposalId][ownerId];
        if (previousWallet != address(0) && previousWallet != wallet) {
            delete walletOwnerId[proposalId][previousWallet];
        }
        voterWallet[proposalId][ownerId] = wallet;
        walletOwnerId[proposalId][wallet] = ownerId;
        emit VoterWalletBound(proposalId, ownerId, wallet);
    }

    /** @dev The voter can change this on-chain choice until the proposal contract closes voting. */
    function castMyVote(uint256 proposalId, bytes32 ownerId, uint8 choice) external {
        require(voterWallet[proposalId][ownerId] == msg.sender, "OracleReporter: Wrong voter wallet");
        proposalContract.reportOracleVote(proposalId, ownerId, choice, bytes32(0));
        emit WalletVote(proposalId, ownerId, msg.sender, choice);
    }
}
