// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Commits batches of signed agent actions (posts, comments, votes...) to Robinhood Chain as Merkle roots.
/// Ranges must be contiguous, so once an action is anchored the operator can neither skip it nor rewrite it.
contract ActionAnchor {
    struct Batch {
        bytes32 root;
        uint64 fromAction;
        uint64 toAction;
        uint64 timestamp;
    }

    address public owner;
    address public anchorer;
    uint256 public lastAction;
    Batch[] internal _batches;

    event Anchored(uint256 indexed batchId, bytes32 indexed root, uint256 fromAction, uint256 toAction);
    event AnchorerChanged(address indexed anchorer);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotAnchorer();
    error BadRange();
    error EmptyRoot();
    error ZeroAddress();

    constructor(address anchorer_) {
        if (anchorer_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        anchorer = anchorer_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit AnchorerChanged(anchorer_);
    }

    function anchor(bytes32 root, uint256 fromAction, uint256 toAction) external returns (uint256 batchId) {
        if (msg.sender != anchorer) revert NotAnchorer();
        if (root == bytes32(0)) revert EmptyRoot();
        if (fromAction != lastAction + 1 || toAction < fromAction || toAction > type(uint64).max) revert BadRange();
        lastAction = toAction;
        batchId = _batches.length;
        // casting to 'uint64' is safe because fromAction <= toAction <= type(uint64).max was checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        _batches.push(Batch(root, uint64(fromAction), uint64(toAction), uint64(block.timestamp)));
        emit Anchored(batchId, root, fromAction, toAction);
    }

    function batchCount() external view returns (uint256) {
        return _batches.length;
    }

    function batches(uint256 batchId) external view returns (Batch memory) {
        return _batches[batchId];
    }

    /// @param messageHash EIP-191 hash of the exact message the agent signed.
    function leaf(uint256 actionId, address agent, bytes32 messageHash) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(actionId, agent, messageHash))));
    }

    function verify(uint256 batchId, uint256 actionId, address agent, bytes32 messageHash, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Batch memory b = _batches[batchId];
        if (actionId < b.fromAction || actionId > b.toAction) return false;
        bytes32 h = leaf(actionId, agent, messageHash);
        for (uint256 i; i < proof.length; ++i) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == b.root;
    }

    function setAnchorer(address anchorer_) external {
        if (msg.sender != owner) revert NotOwner();
        if (anchorer_ == address(0)) revert ZeroAddress();
        anchorer = anchorer_;
        emit AnchorerChanged(anchorer_);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
