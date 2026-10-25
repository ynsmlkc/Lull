# Lull Vault — Project Memory

> Built with Arc Studio — https://studio.arc.io

## What This App Does

Public dashboard for the Lull Vault: live vault stats, activity feed of on-chain events, and a "Fund the vault" flow that lets advertisers send USDC directly to the vault on Arc mainnet.

## Contract

- **LullVault** on Arc mainnet (chain ID 5042)
- Address: `0x6f3f3008eb689F2f0AC82dC08bBBb5Fc3ECc15c5`
- Deploy block: 27826765
- Explorer: https://explorer.arc.io/address/0x6f3f3008eb689F2f0AC82dC08bBBb5Fc3ECc15c5
- USDC (ERC-20): `0x3600000000000000000000000000000000000000` (6 decimals). Native USDC on Arc uses 18 decimals — never mix.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS (Arc Dark theme)
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/LullVault.sol`, tests in `contracts/test/LullVault.t.sol` and `contracts/test/LullVault.Invariant.t.sol`.
- Wallet: injected (MetaMask, Rabby, Coinbase Wallet)
- Chain: Arc mainnet (chainId 5042)
- Token: USDC (6 decimals, `0x3600000000000000000000000000000000000000`)

## Key Files

- `src/App.tsx` — top-level layout (header, stats, fund card, activity feed)
- `src/components/VaultStats.tsx` — live reads: balance, operator, owner, paused (15s refresh)
- `src/components/ActivityFeed.tsx` — Paid / BatchPaid / Deposited / Transfer events from block 27826765
- `src/components/FundVault.tsx` — wallet connect + USDC transfer to vault
- `src/constants.ts` — vault address, USDC address, ABIs, chain ID
- `src/config.ts` — wagmi config (arcMainnet, arcTestnet, mainnet)

## Verified Mainnet Reads (2026-10-25)

- balance(): 500,000 (6 dec) = 0.500000 USDC ✓
- operator(): 0x074fa7b3154c49cb93ef69aa2647bd3dd4877dbd ✓
- owner(): 0x074fa7b3154c49cb93ef69aa2647bd3dd4877dbd ✓
- paused(): false (Active) ✓

## Rename History

Contract was renamed from LingerVault → LullVault. Old LingerVault.sol deleted. All test files updated to LullVault.
