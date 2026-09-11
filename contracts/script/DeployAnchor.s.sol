// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ActionAnchor} from "../src/ActionAnchor.sol";

/// forge script script/DeployAnchor.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --account <keystore> --broadcast
/// ANCHORER = address of the server's hot wallet (the one whose key sits in the server .env).
contract DeployAnchor is Script {
    function run() external returns (ActionAnchor anchor) {
        address anchorer = vm.envAddress("ANCHORER");
        vm.startBroadcast();
        anchor = new ActionAnchor(anchorer);
        vm.stopBroadcast();
        console.log("ActionAnchor", address(anchor));
    }
}
