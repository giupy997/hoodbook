// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ActionAnchor} from "../src/ActionAnchor.sol";

contract ActionAnchorTest is Test {
    ActionAnchor anchor;
    address anchorer = makeAddr("anchorer");
    address agent = 0x00000000000000000000000000000000000A11cE;

    // Vector produced by src/merkle.ts (leafFor / merkleRoot / merkleProof) for messages
    // "hello", "world", "agents" signed by `agent` as actions 1, 2, 3.
    bytes32 constant ROOT = 0x69f08b97044e087dc6d9dbda98416994eaca2e233878baf477eaadb9be56ad31;
    bytes32 constant LEAF1 = 0xae4e2cc2d57adcf454fc42181c4cba41daa8487cdcc9afc27d63bcad738d1105;
    bytes32 constant LEAF2 = 0x69f37beb2a0462f44f13b09d5a6f88a97e23d6e0d20768a59c769e4213a95f93;
    bytes32 constant LEAF3 = 0x5ed6ebffec3da01178e4ba5ad111a477a9257182e32eea17777dd4aa569a8b1b;
    bytes32 constant NODE12 = 0xae699c0b233f3226a0e840f21e4d88713f0f37f05c45f4ad130a65cdfe0738f5;

    function setUp() public {
        anchor = new ActionAnchor(anchorer);
    }

    function test_leafMatchesTypeScript() public view {
        assertEq(anchor.leaf(1, agent, _ethMessageHash("hello")), LEAF1);
        assertEq(anchor.leaf(2, agent, _ethMessageHash("world")), LEAF2);
        assertEq(anchor.leaf(3, agent, _ethMessageHash("agents")), LEAF3);
    }

    function test_verifyTypeScriptProofs() public {
        vm.prank(anchorer);
        assertEq(anchor.anchor(ROOT, 1, 3), 0);

        bytes32[] memory proof0 = new bytes32[](2);
        proof0[0] = LEAF2;
        proof0[1] = LEAF3;
        assertTrue(anchor.verify(0, 1, agent, _ethMessageHash("hello"), proof0));

        bytes32[] memory proof2 = new bytes32[](1);
        proof2[0] = NODE12;
        assertTrue(anchor.verify(0, 3, agent, _ethMessageHash("agents"), proof2));

        assertFalse(anchor.verify(0, 1, agent, _ethMessageHash("forged"), proof0));
        assertFalse(anchor.verify(0, 1, makeAddr("impostor"), _ethMessageHash("hello"), proof0));
        assertFalse(anchor.verify(0, 4, agent, _ethMessageHash("hello"), proof0));
    }

    function test_rangesMustBeContiguous() public {
        vm.startPrank(anchorer);
        vm.expectRevert(ActionAnchor.BadRange.selector);
        anchor.anchor(ROOT, 2, 3);

        anchor.anchor(ROOT, 1, 3);
        assertEq(anchor.lastAction(), 3);

        vm.expectRevert(ActionAnchor.BadRange.selector);
        anchor.anchor(ROOT, 3, 5);
        vm.expectRevert(ActionAnchor.BadRange.selector);
        anchor.anchor(ROOT, 5, 6);
        vm.expectRevert(ActionAnchor.BadRange.selector);
        anchor.anchor(ROOT, 4, 3);
        vm.expectRevert(ActionAnchor.EmptyRoot.selector);
        anchor.anchor(bytes32(0), 4, 4);

        assertEq(anchor.anchor(ROOT, 4, 4), 1);
        assertEq(anchor.batchCount(), 2);
        ActionAnchor.Batch memory b = anchor.batches(1);
        assertEq(b.fromAction, 4);
        assertEq(b.toAction, 4);
        vm.stopPrank();
    }

    function test_onlyAnchorerCanAnchor() public {
        vm.expectRevert(ActionAnchor.NotAnchorer.selector);
        anchor.anchor(ROOT, 1, 3);
    }

    function test_ownerRotatesAnchorer() public {
        address next = makeAddr("next");
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ActionAnchor.NotOwner.selector);
        anchor.setAnchorer(next);

        anchor.setAnchorer(next);
        vm.prank(anchorer);
        vm.expectRevert(ActionAnchor.NotAnchorer.selector);
        anchor.anchor(ROOT, 1, 3);
        vm.prank(next);
        anchor.anchor(ROOT, 1, 3);
    }

    function _ethMessageHash(string memory message) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", vm.toString(bytes(message).length), message));
    }
}
