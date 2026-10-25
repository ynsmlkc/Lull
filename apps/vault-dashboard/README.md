# Lull Vault Dashboard

A public dashboard for the Lull Vault — a USDC escrow contract on Arc mainnet that holds advertiser funds and pays out developers for serving ads in AI coding tools.

Built with [Arc Studio](https://studio.arc.io)

## Features

- Live vault stats (USDC balance, operator, owner, pause state) refreshed every 15 seconds
- Activity feed of all Paid, BatchPaid, Deposited, and inbound USDC Transfer events from contract deployment onward
- "Fund the vault" card: connect a wallet, switch to Arc mainnet, enter an amount, and send a USDC transfer in one transaction
- Explorer links for every event and transaction

## Tech Stack

- React 18, Vite, TypeScript, Tailwind CSS
- wagmi v2, viem, ConnectKit (injected wallets: MetaMask, Rabby, Coinbase Wallet)
- Arc mainnet (chain ID 5042), USDC (ERC-20, 6 decimals)
- Solidity 0.8.28, Foundry (unit + invariant tests)

## Contract

| | |
|---|---|
| Contract | LullVault |
| Network | Arc mainnet (chain ID 5042) |
| Address | `0x6f3f3008eb689F2f0AC82dC08bBBb5Fc3ECc15c5` |
| USDC | `0x3600000000000000000000000000000000000000` |
| Explorer | https://explorer.arc.io/address/0x6f3f3008eb689F2f0AC82dC08bBBb5Fc3ECc15c5 |

## Development

### Prerequisites

- [Bun](https://bun.sh) (package manager and runtime)
- [Foundry](https://getfoundry.sh) (for contract builds and tests)

### Install

```bash
bun install
```

### Environment Variables

None required for the dashboard. The app reads Arc mainnet via the public RPC `https://rpc.mainnet.arc.io`.

### Run

```bash
bun run dev
```

### Build

```bash
bun run build
```

### Test (contracts)

```bash
bun run contracts:test
```

## Links

- Lull server: https://lullserver-production.up.railway.app
- GitHub: https://github.com/ynsmlkc/Lull
