// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev 6-decimal mock USDC with open mint.
contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Mock whose transfers/transferFrom revert when the destination is the configured blocked address.
contract MockBlockableERC20 is MockERC20 {
    error BlockedRecipient(address to);

    address public blocked;

    function setBlocked(address who) external {
        blocked = who;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked != address(0) && to == blocked) revert BlockedRecipient(to);
        super._update(from, to, value);
    }
}
