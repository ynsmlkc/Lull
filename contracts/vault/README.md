# LingerVault

Holds advertiser USDC on Arc and pays developers in atomic, replay-protected batches.

Written, security-reviewed and tested in [Arc Studio](https://studio.arc.io). The prompt is in [`ARC-STUDIO-PROMPT.md`](ARC-STUDIO-PROMPT.md), and the Studio app and its testnet deployment are recorded in [`arc-studio-session.json`](arc-studio-session.json).

| Function | Who | What |
|---|---|---|
| `deposit(amount)` | anyone | pulls approved USDC; a plain `transfer` to the vault works too |
| `payout(batchId, recipients, amounts)` | operator | pays 1–64 recipients atomically; each `batchId` is accepted once |
| `setOperator(addr)` | owner | replaces the server hot wallet |
| `pause()` / `unpause()` | owner | blocks payouts only, never deposits |
| `rescue(to, amount)` | owner | emergency exit for held USDC |

Ownership is two-step (`Ownable2Step`) and `renounceOwnership` is disabled, so funds cannot be locked by renouncing while paused. There is no `receive`, so native value sent to the vault reverts.

## Test

```bash
git clone -q --depth 1 --branch v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
git clone -q --depth 1 --branch v1.9.4 https://github.com/foundry-rs/forge-std lib/forge-std
forge test
```

## Deploy

USDC defaults to Arc's ERC-20 interface, `0x3600000000000000000000000000000000000000`, which is the same address on testnet and mainnet.

```bash
VAULT_OWNER=0x…      # cold wallet: pause, rescue, replace operator
VAULT_OPERATOR=0x…   # server hot wallet (LINGER_OPERATOR_KEY)
forge script script/DeployLingerVault.s.sol --rpc-url arc_mainnet --broadcast --private-key $DEPLOYER_KEY
```

Then set `LINGER_VAULT` and `LINGER_VAULT_FROM_BLOCK` on the server.
