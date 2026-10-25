// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LullVault} from "../src/LullVault.sol";

/// @notice Deploys LullVault on Arc.
/// @dev Env: VAULT_OWNER (cold wallet that can pause/rescue), VAULT_OPERATOR (server hot wallet).
/// USDC defaults to Arc's ERC-20 interface, the same address on testnet and mainnet.
contract DeployLullVault is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external returns (LullVault vault) {
        address owner = vm.envAddress("VAULT_OWNER");
        address operator = vm.envAddress("VAULT_OPERATOR");
        address usdc = vm.envOr("VAULT_USDC", ARC_USDC);

        vm.startBroadcast();
        vault = new LullVault(IERC20(usdc), owner, operator);
        vm.stopBroadcast();

        console2.log("LullVault", address(vault));
        console2.log("owner", owner);
        console2.log("operator", operator);
        console2.log("block", block.number);
    }
}
