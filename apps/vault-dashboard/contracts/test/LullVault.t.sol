// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {LullVault} from "../LullVault.sol";
import {MockERC20, MockBlockableERC20} from "./mocks/LullMocks.sol";

contract LullVaultTest is Test {
    LullVault internal vault;
    MockBlockableERC20 internal usdc;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal advertiser = makeAddr("advertiser");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant BATCH = keccak256("batch-1");
    uint256 internal constant FUNDS = 10_000e6;

    function setUp() public {
        usdc = new MockBlockableERC20();
        vault = new LullVault(IERC20(address(usdc)), owner, operator);
        usdc.mint(advertiser, FUNDS);
        vm.prank(advertiser);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ---------- helpers ----------
    function _fund(uint256 amt) internal {
        vm.prank(advertiser);
        vault.deposit(amt);
    }

    function _arrs2(address a, uint256 x, address b, uint256 y)
        internal
        pure
        returns (address[] memory r, uint256[] memory m)
    {
        r = new address[](2);
        m = new uint256[](2);
        r[0] = a;
        r[1] = b;
        m[0] = x;
        m[1] = y;
    }

    function _arrs3() internal view returns (address[] memory r, uint256[] memory m) {
        r = new address[](3);
        m = new uint256[](3);
        r[0] = alice;
        r[1] = bob;
        r[2] = carol;
        m[0] = 10e6;
        m[1] = 20e6;
        m[2] = 30e6;
    }

    function _sized(uint256 n, uint256 amt) internal pure returns (address[] memory r, uint256[] memory m) {
        r = new address[](n);
        m = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            r[i] = address(uint160(0x1000 + i));
            m[i] = amt;
        }
    }

    // ---------- constructor ----------
    function test_Constructor_SetsState() public view {
        assertEq(address(vault.usdc()), address(usdc));
        assertEq(vault.owner(), owner);
        assertEq(vault.operator(), operator);
        assertEq(vault.MAX_BATCH(), 64);
        assertFalse(vault.paused());
    }

    function test_Constructor_EmitsOperatorChanged() public {
        vm.expectEmit(true, true, false, false);
        emit LullVault.OperatorChanged(address(0), operator);
        new LullVault(IERC20(address(usdc)), owner, operator);
    }

    function test_Constructor_ZeroUsdcReverts() public {
        vm.expectRevert(LullVault.ZeroAddress.selector);
        new LullVault(IERC20(address(0)), owner, operator);
    }

    function test_Constructor_ZeroOperatorReverts() public {
        vm.expectRevert(LullVault.ZeroAddress.selector);
        new LullVault(IERC20(address(usdc)), owner, address(0));
    }

    function test_Constructor_ZeroOwnerReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new LullVault(IERC20(address(usdc)), address(0), operator);
    }

    // ---------- deposit / balance ----------
    function test_Deposit_PullsFromSenderAndEmits() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit LullVault.Deposited(advertiser, 500e6);
        vm.prank(advertiser);
        vault.deposit(500e6);
        assertEq(vault.balance(), 500e6);
        assertEq(usdc.balanceOf(advertiser), FUNDS - 500e6);
        assertEq(usdc.balanceOf(address(vault)), 500e6);
    }

    function test_Deposit_ZeroReverts() public {
        vm.prank(advertiser);
        vm.expectRevert(LullVault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_Deposit_WithoutAllowanceReverts() public {
        usdc.mint(stranger, 1e6);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, 1e6)
        );
        vault.deposit(1e6);
    }

    function test_Balance_CountsDirectTransfer() public {
        _fund(100e6);
        vm.prank(advertiser);
        usdc.transfer(address(vault), 50e6);
        assertEq(vault.balance(), 150e6);
    }

    // ---------- payout happy path ----------
    function test_Payout_HappyPath() public {
        _fund(1_000e6);
        (address[] memory r, uint256[] memory m) = _arrs3();

        vm.expectEmit(true, true, false, true, address(vault));
        emit LullVault.Paid(BATCH, alice, 10e6);
        vm.expectEmit(true, true, false, true, address(vault));
        emit LullVault.Paid(BATCH, bob, 20e6);
        vm.expectEmit(true, true, false, true, address(vault));
        emit LullVault.Paid(BATCH, carol, 30e6);
        vm.expectEmit(true, false, false, true, address(vault));
        emit LullVault.BatchPaid(BATCH, 3, 60e6);

        vm.prank(operator);
        vault.payout(BATCH, r, m);

        assertEq(usdc.balanceOf(alice), 10e6);
        assertEq(usdc.balanceOf(bob), 20e6);
        assertEq(usdc.balanceOf(carol), 30e6);
        assertEq(vault.balance(), 940e6);
        assertTrue(vault.batchPaid(BATCH));
    }

    function test_Payout_ReplayReverts() public {
        _fund(1_000e6);
        (address[] memory r, uint256[] memory m) = _arrs3();
        vm.prank(operator);
        vault.payout(BATCH, r, m);
        vm.prank(operator);
        vm.expectRevert(LullVault.BatchAlreadyPaid.selector);
        vault.payout(BATCH, r, m);
        assertEq(usdc.balanceOf(alice), 10e6);
    }

    function test_Payout_NonOperatorReverts() public {
        _fund(1_000e6);
        (address[] memory r, uint256[] memory m) = _arrs3();
        vm.prank(stranger);
        vm.expectRevert(LullVault.NotOperator.selector);
        vault.payout(BATCH, r, m);
    }

    function test_Payout_OwnerIsNotOperator() public {
        _fund(1_000e6);
        (address[] memory r, uint256[] memory m) = _arrs3();
        vm.prank(owner);
        vm.expectRevert(LullVault.NotOperator.selector);
        vault.payout(BATCH, r, m);
    }

    // ---------- pause ----------
    function test_Paused_PayoutRevertsDepositWorksUnpauseRestores() public {
        _fund(1_000e6);
        (address[] memory r, uint256[] memory m) = _arrs3();
        vm.prank(owner);
        vault.pause();
        assertTrue(vault.paused());

        vm.prank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.payout(BATCH, r, m);

        _fund(5e6); // deposit still works
        assertEq(vault.balance(), 1_005e6);

        vm.prank(owner);
        vault.unpause();
        assertFalse(vault.paused());
        vm.prank(operator);
        vault.payout(BATCH, r, m);
        assertTrue(vault.batchPaid(BATCH));
    }

    function test_PauseUnpause_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.pause();

        vm.prank(owner);
        vault.pause();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        vault.unpause();
    }

    // ---------- payout validation ----------
    function test_Payout_LengthMismatchReverts() public {
        _fund(1_000e6);
        address[] memory r = new address[](2);
        uint256[] memory m = new uint256[](1);
        r[0] = alice;
        r[1] = bob;
        m[0] = 1e6;
        vm.prank(operator);
        vm.expectRevert(LullVault.LengthMismatch.selector);
        vault.payout(BATCH, r, m);
    }

    function test_Payout_EmptyReverts() public {
        vm.prank(operator);
        vm.expectRevert(LullVault.EmptyBatch.selector);
        vault.payout(BATCH, new address[](0), new uint256[](0));
    }

    function test_Payout_Max64Ok() public {
        _fund(1_000e6);
        (address[] memory r, uint256[] memory m) = _sized(64, 1e6);
        vm.prank(operator);
        vault.payout(BATCH, r, m);
        assertEq(vault.balance(), 1_000e6 - 64e6);
        assertTrue(vault.batchPaid(BATCH));
    }

    function test_Payout_65Reverts() public {
        _fund(1_000e6);
        (address[] memory r, uint256[] memory m) = _sized(65, 1e6);
        vm.prank(operator);
        vm.expectRevert(LullVault.BatchTooLarge.selector);
        vault.payout(BATCH, r, m);
    }

    function test_Payout_ZeroRecipientReverts() public {
        _fund(1_000e6);
        (address[] memory r, uint256[] memory m) = _arrs2(alice, 1e6, address(0), 1e6);
        vm.prank(operator);
        vm.expectRevert(LullVault.ZeroAddress.selector);
        vault.payout(BATCH, r, m);
    }

    function test_Payout_ZeroAmountReverts() public {
        _fund(1_000e6);
        (address[] memory r, uint256[] memory m) = _arrs2(alice, 1e6, bob, 0);
        vm.prank(operator);
        vm.expectRevert(LullVault.ZeroAmount.selector);
        vault.payout(BATCH, r, m);
    }

    function test_Payout_VaultRecipientReverts() public {
        _fund(1_000e6);
        (address[] memory r, uint256[] memory m) = _arrs2(alice, 1e6, address(vault), 1e6);
        vm.prank(operator);
        vm.expectRevert(LullVault.InvalidRecipient.selector);
        vault.payout(BATCH, r, m);
    }

    // ---------- atomicity ----------
    function test_Payout_BlockedRecipientIsAtomicThenRetryable() public {
        _fund(1_000e6);
        (address[] memory r, uint256[] memory m) = _arrs3();
        usdc.setBlocked(bob); // middle recipient

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MockBlockableERC20.BlockedRecipient.selector, bob));
        vault.payout(BATCH, r, m);

        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(bob), 0);
        assertEq(usdc.balanceOf(carol), 0);
        assertEq(vault.balance(), 1_000e6);
        assertFalse(vault.batchPaid(BATCH));

        // retry without bob under the same batchId
        (address[] memory r2, uint256[] memory m2) = _arrs2(alice, 10e6, carol, 30e6);
        vm.prank(operator);
        vault.payout(BATCH, r2, m2);
        assertEq(usdc.balanceOf(alice), 10e6);
        assertEq(usdc.balanceOf(carol), 30e6);
        assertEq(vault.balance(), 960e6);
        assertTrue(vault.batchPaid(BATCH));
    }

    function test_Payout_InsufficientBalanceIsAtomic() public {
        _fund(100e6);
        (address[] memory r, uint256[] memory m) = _arrs2(alice, 60e6, bob, 60e6);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(vault), 40e6, 60e6)
        );
        vault.payout(BATCH, r, m);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(bob), 0);
        assertEq(vault.balance(), 100e6);
        assertFalse(vault.batchPaid(BATCH));
    }

    // ---------- rescue ----------
    function test_Rescue_OwnerWithdrawsAndEmits() public {
        _fund(100e6);
        vm.expectEmit(true, false, false, true, address(vault));
        emit LullVault.Rescued(stranger, 40e6);
        vm.prank(owner);
        vault.rescue(stranger, 40e6);
        assertEq(usdc.balanceOf(stranger), 40e6);
        assertEq(vault.balance(), 60e6);
    }

    function test_Rescue_WorksWhilePaused() public {
        _fund(100e6);
        vm.startPrank(owner);
        vault.pause();
        vault.rescue(owner, 100e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(owner), 100e6);
        assertEq(vault.balance(), 0);
    }

    function test_Rescue_NonOwnerReverts() public {
        _fund(100e6);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.rescue(stranger, 1e6);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        vault.rescue(operator, 1e6);
    }

    function test_Rescue_ZeroAddressReverts() public {
        _fund(100e6);
        vm.prank(owner);
        vm.expectRevert(LullVault.ZeroAddress.selector);
        vault.rescue(address(0), 1e6);
    }

    function test_Rescue_MoreThanBalanceReverts() public {
        _fund(100e6);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(vault), 100e6, 101e6)
        );
        vault.rescue(owner, 101e6);
    }

    // ---------- setOperator ----------
    function test_SetOperator_OwnerChangesAndEmits() public {
        address newOp = makeAddr("newOp");
        vm.expectEmit(true, true, false, false, address(vault));
        emit LullVault.OperatorChanged(operator, newOp);
        vm.prank(owner);
        vault.setOperator(newOp);
        assertEq(vault.operator(), newOp);
    }

    function test_SetOperator_OldOperatorLosesAccess() public {
        _fund(100e6);
        address newOp = makeAddr("newOp");
        vm.prank(owner);
        vault.setOperator(newOp);
        (address[] memory r, uint256[] memory m) = _arrs3();

        vm.prank(operator);
        vm.expectRevert(LullVault.NotOperator.selector);
        vault.payout(BATCH, r, m);

        vm.prank(newOp);
        vault.payout(BATCH, r, m);
        assertTrue(vault.batchPaid(BATCH));
    }

    function test_SetOperator_NonOwnerReverts() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        vault.setOperator(stranger);
    }

    function test_SetOperator_ZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(LullVault.ZeroAddress.selector);
        vault.setOperator(address(0));
    }

    // ---------- ownership ----------
    function test_Ownable2Step_RequiresAccept() public {
        vm.prank(owner);
        vault.transferOwnership(alice);
        assertEq(vault.owner(), owner);
        assertEq(vault.pendingOwner(), alice);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.acceptOwnership();

        vm.prank(alice);
        vault.acceptOwnership();
        assertEq(vault.owner(), alice);
        assertEq(vault.pendingOwner(), address(0));

        // old owner lost admin rights
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        vault.pause();
    }

    function test_RenounceOwnership_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(LullVault.RenounceDisabled.selector);
        vault.renounceOwnership();
        assertEq(vault.owner(), owner);
    }

    function test_RenounceOwnership_NonOwnerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.renounceOwnership();
    }

    // ---------- native ETH ----------
    function test_NativeEth_PlainSendFails() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(vault).balance, 0);
    }

    function test_NativeEth_CallWithDataFails() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(vault).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok);
        assertEq(address(vault).balance, 0);
    }

    // ---------- fuzz ----------
    function testFuzz_Payout_TotalsConserved(uint8 nRaw, uint256 seed) public {
        uint256 n = bound(nRaw, 1, 64);
        address[] memory r = new address[](n);
        uint256[] memory m = new uint256[](n);
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            r[i] = address(uint160(0x1000 + i));
            m[i] = bound(uint256(keccak256(abi.encode(seed, i))), 1, 100e6);
            total += m[i];
        }
        usdc.mint(address(vault), total + 7); // direct funding, 7 extra units stay
        bytes32 id = keccak256(abi.encode(seed));

        vm.expectEmit(true, false, false, true, address(vault));
        emit LullVault.BatchPaid(id, n, total);
        vm.prank(operator);
        vault.payout(id, r, m);

        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            assertEq(usdc.balanceOf(r[i]), m[i]);
            sum += usdc.balanceOf(r[i]);
        }
        assertEq(sum, total);
        assertEq(vault.balance(), 7);
        assertTrue(vault.batchPaid(id));
    }
}
