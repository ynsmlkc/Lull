Write, test and deploy to Arc testnet a Solidity contract `LingerVault` (balanced preset, Foundry tests required).

Context: Linger is an ad marketplace for AI coding tools. Advertisers pay USDC; developers who see terminal ads earn micro-USDC. An off-chain server keeps the ledger and periodically pays developers in batches. This vault holds advertiser funds and executes those batched payouts.

Token: USDC ERC-20 interface on Arc at 0x3600000000000000000000000000000000000000 (6 decimals). Pass the token address to the constructor (so tests can use a mock ERC20). Use SafeERC20.

Requirements:
- constructor(IERC20 usdc, address owner, address operator). Ownable2Step for owner. Separate `operator` role (the server's hot wallet) settable by owner: setOperator(address). Emit OperatorChanged.
- deposit(uint256 amount): pulls USDC with transferFrom from msg.sender, emits Deposited(address indexed from, uint256 amount). (Plain ERC-20 transfers straight to the vault must also be fine; the server attributes deposits from USDC Transfer logs.)
- payout(bytes32 batchId, address[] calldata recipients, uint256[] calldata amounts) external onlyOperator whenNotPaused nonReentrant:
  * revert if batchId already used (replay guard: mapping(bytes32 => bool) public batchPaid). This is the core safety property: the same batch can never be paid twice, even if the server resubmits.
  * lengths equal, 1..64 items, no zero address, no zero amount, recipient != address(this).
  * atomic: if any transfer fails the whole batch reverts.
  * emit Paid(bytes32 indexed batchId, address indexed to, uint256 amount) per item and BatchPaid(bytes32 indexed batchId, uint256 count, uint256 total).
- pause()/unpause() onlyOwner (OpenZeppelin Pausable). Paused blocks payout only, never deposit.
- rescue(address to, uint256 amount) onlyOwner: owner can move USDC out (emergency); emit Rescued.
- No receive()/fallback: native value must be rejected.
- view balance() returns USDC held.

Tests: deposit; direct transfer; payout happy path with events; replay of same batchId reverts; non-operator reverts; paused reverts payout but allows deposit; length mismatch / empty / >64 / zero address / zero amount revert; atomicity (one recipient blocked by a mock token that reverts for a given address → nothing paid, batchId stays unused); rescue only owner; setOperator only owner.

Deploy to Arc testnet with the real USDC address, owner = operator = the deployer for now. Report address and tx hash.
