// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LullVault} from "../LullVault.sol";
import {MockERC20} from "./mocks/LullMocks.sol";

contract VaultHandler is Test {
    LullVault public vault;
    MockERC20 public usdc;
    address public operator;
    address public depositor = address(0xD0);
    uint256 public minted;
    uint256 public nonce;
    address[] public paidTo;

    constructor(LullVault v, MockERC20 t, address op) {
        vault = v;
        usdc = t;
        operator = op;
    }

    function deposit(uint256 amt) external {
        amt = bound(amt, 1, 1_000e6);
        usdc.mint(depositor, amt);
        minted += amt;
        vm.startPrank(depositor);
        usdc.approve(address(vault), amt);
        vault.deposit(amt);
        vm.stopPrank();
    }

    function payout(uint8 nRaw, uint256 seed) external {
        uint256 n = bound(nRaw, 1, 8);
        address[] memory r = new address[](n);
        uint256[] memory m = new uint256[](n);
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            r[i] = address(uint160(0x5000 + (uint256(keccak256(abi.encode(seed, i))) % 16)));
            m[i] = bound(uint256(keccak256(abi.encode(i, seed))), 1, 50e6);
            total += m[i];
        }
        if (total > vault.balance()) return; // would revert atomically; covered by unit tests
        vm.prank(operator);
        vault.payout(bytes32(++nonce), r, m);
        for (uint256 i = 0; i < n; i++) {
            paidTo.push(r[i]);
        }
    }

    function sumPaid() external view returns (uint256 s) {
        // recipients repeat; sum balances over the fixed 16-address pool
        for (uint256 i = 0; i < 16; i++) {
            s += usdc.balanceOf(address(uint160(0x5000 + i)));
        }
    }
}

contract LullVaultInvariantTest is Test {
    LullVault internal vault;
    MockERC20 internal usdc;
    VaultHandler internal handler;

    function setUp() public {
        usdc = new MockERC20();
        address op = makeAddr("operator");
        vault = new LullVault(IERC20(address(usdc)), makeAddr("owner"), op);
        handler = new VaultHandler(vault, usdc, op);
        targetContract(address(handler));
    }

    /// Conservation: every minted unit is either in the vault, with recipients, or with the depositor (nothing leaks).
    function invariant_FundsConserved() public view {
        assertEq(vault.balance() + handler.sumPaid(), handler.minted());
    }
}
