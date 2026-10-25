// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title LullVault
/// @notice Holds advertiser USDC and executes operator-authorized, atomic developer payouts.
/// @dev Accounting and payout authorization are maintained off-chain. Amounts are in the
/// token's smallest units (six decimals for USDC). Direct ERC-20 transfers are supported.
/// The owner can replace the operator, pause payouts, and rescue all held USDC.
contract LullVault is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Maximum recipients allowed in one payout batch.
    uint256 public constant MAX_BATCH = 64;

    /// @notice USDC token held by this vault.
    IERC20 public immutable usdc;

    /// @notice Server hot wallet authorized to submit payout batches.
    address public operator;

    /// @notice Whether a batch identifier has already been successfully paid.
    mapping(bytes32 => bool) public batchPaid;

    error NotOperator();
    error BatchAlreadyPaid();
    error LengthMismatch();
    error EmptyBatch();
    error BatchTooLarge();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidRecipient();
    error RenounceDisabled();

    event OperatorChanged(address indexed previousOperator, address indexed newOperator);
    event Deposited(address indexed from, uint256 amount);
    event Paid(bytes32 indexed batchId, address indexed to, uint256 amount);
    event BatchPaid(bytes32 indexed batchId, uint256 count, uint256 total);
    event Rescued(address indexed to, uint256 amount);

    /// @param usdc_ USDC token; on Arc, 0x3600000000000000000000000000000000000000.
    /// @param owner_  Initial owner; subsequent ownership transfers require acceptance.
    /// @param operator_ Initial server hot wallet permitted to pay batches.
    constructor(IERC20 usdc_, address owner_, address operator_) Ownable(owner_) {
        if (address(usdc_) == address(0) || operator_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        operator = operator_;
        emit OperatorChanged(address(0), operator_);
    }

    /// @dev Restricts payout submission to the current operator.
    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /// @notice Replaces the server hot wallet authorized to submit payouts.
    /// @param newOperator Nonzero replacement operator address.
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        address previousOperator = operator;
        operator = newOperator;
        emit OperatorChanged(previousOperator, newOperator);
    }

    /// @notice Deposits approved USDC, including while payouts are paused.
    /// @param amount Nonzero amount in the token's smallest units.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Pays an entire batch atomically, using each batch identifier at most once.
    /// @dev Records the identifier before any token transfer. Any failure rolls back the
    /// identifier, all transfers, and all events, so a failed batch can be retried.
    /// @param batchId Unique off-chain batch identifier.
    /// @param recipients One to MAX_BATCH nonzero recipients other than this vault.
    /// @param amounts Nonzero token amounts corresponding to each recipient.
    function payout(bytes32 batchId, address[] calldata recipients, uint256[] calldata amounts)
        external
        onlyOperator
        whenNotPaused
        nonReentrant
    {
        if (batchPaid[batchId]) revert BatchAlreadyPaid();
        uint256 count = recipients.length;
        if (count != amounts.length) revert LengthMismatch();
        if (count == 0) revert EmptyBatch();
        if (count > MAX_BATCH) revert BatchTooLarge();

        uint256 total;
        for (uint256 i = 0; i < count; ++i) {
            if (recipients[i] == address(0)) revert ZeroAddress();
            if (recipients[i] == address(this)) revert InvalidRecipient();
            if (amounts[i] == 0) revert ZeroAmount();
            total += amounts[i];
        }

        batchPaid[batchId] = true;
        for (uint256 i = 0; i < count; ++i) {
            usdc.safeTransfer(recipients[i], amounts[i]);
            emit Paid(batchId, recipients[i], amounts[i]);
        }
        emit BatchPaid(batchId, count, total);
    }

    /// @notice Pauses payouts without blocking deposits or owner rescue.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resumes operator payouts.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Withdraws USDC for emergency recovery, including while paused.
    /// @param to Nonzero address receiving the rescued USDC.
    /// @param amount Amount of USDC to transfer in the token's smallest units.
    function rescue(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        usdc.safeTransfer(to, amount);
        emit Rescued(to, amount);
    }

    /// @notice Disabled: renouncing ownership while paused would permanently lock funds.
    /// @dev Use the two-step transfer to hand over administration instead.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @notice Returns the USDC balance held by this vault, including direct transfers.
    /// @return The current balance in the token's smallest units.
    function balance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }
}
