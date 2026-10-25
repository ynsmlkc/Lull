# Lull on Arc

> Terminal-native ad marketplace that turns AI coding wait states into revenue, paid out in USDC on Arc.

While Claude Code is thinking, a single clearly-disclosed sponsored line appears in the status line. Verified impressions accrue to the developer's balance, and the developer can withdraw any amount at any time, straight from an on-chain vault, in one Arc transaction. No bank account, no country restrictions, no payout threshold.

**Status: live on Arc mainnet.** Real USDC moves through `LullVault`.

| | |
|---|---|
| Site & API | https://lullserver-production.up.railway.app |
| Vault (Arc mainnet) | [`0x6f3f3008eb689F2f0AC82dC08bBBb5Fc3ECc15c5`](https://explorer.arc.io/address/0x6f3f3008eb689F2f0AC82dC08bBBb5Fc3ECc15c5) |
| CLI | [`lullsh`](https://www.npmjs.com/package/lullsh) on npm |
| Built with | [Arc Studio](https://studio.arc.io) — the vault contract, its audit and its tests |

```bash
npm i -g lullsh && lull init --spinner   # status line + daemon
lull login                                     # connect MetaMask / Rabby / Coinbase Wallet
lull balance                                   # what you've earned
```

Advertisers sign in at `/advertisers/app`, deposit USDC with one click from their wallet and launch a campaign. Developers see what they earned at `/app` and withdraw whenever they like.

---

## Why Arc

Per-impression amounts are tiny, a fraction of a cent. On traditional rails the fixed cost of a payout (transfer fee, FX spread, compliance overhead) routinely exceeds the payout itself. That forces platforms into high thresholds, monthly batches, and a short list of supported countries, and developers in Turkey, Latin America, South Asia and Africa generate value they cannot collect.

Arc removes the parts that made this awkward on other chains:

- **Gas is USDC.** The operator wallet holds one asset. There is no second token to keep topped up, and fees are predictable in dollars.
- **Any address can receive.** No token account to open per recipient, so a first payout of a few cents costs the platform only gas.
- **Deterministic, sub-second finality.** A payout with a receipt is final. The ledger's definition of "paid" is simple and true.

## How money moves

```
advertiser wallet ──USDC transfer──▶ LullVault ──payout(batchId, [devs], [amounts])──▶ developer wallets
                                         ▲
                     operator (server hot wallet) signs payout, pays gas
```

- **Deposits** are plain ERC-20 transfers into the vault (or `deposit()`). The server reads USDC `Transfer` logs into the vault and credits the sender. Advertisers sign in with the same wallet, so no memo is needed.
- **Payouts** are atomic batches. The vault records each `batchId` and refuses to pay it twice, so even a server that crashes mid-payout and retries cannot double-pay on-chain. That guarantee sits underneath the ledger's own idempotency.
- **The money is not in the hot wallet.** The operator can only call `payout`. The owner (a separate wallet) can `pause`, replace the operator, or `rescue` funds.

`LullVault` was written, security-reviewed (manual review and Slither) and tested (40 Foundry tests, including a conservation invariant) in Arc Studio, then deployed to Arc testnet from there. The prompt that produced it is in [`contracts/vault/ARC-STUDIO-PROMPT.md`](contracts/vault/ARC-STUDIO-PROMPT.md), and the Studio session is recorded in [`contracts/vault/arc-studio-session.json`](contracts/vault/arc-studio-session.json).

## Payment rail: failure modes encoded

`ArcRail` (in `packages/payments`) sits behind a small `PaymentRail` interface. Every rule exists because of a way money can go wrong:

| Rule | Why |
|---|---|
| Build and sign once, record, *then* send. Retries resend the same bytes. | A crash between "sent" and "recorded" would otherwise leave money paid but still payable. Same bytes = same nonce = applied at most once. |
| `estimateGas` simulates the batch before signing. | A blocked recipient, an already-paid batch, a paused vault or an empty vault fails here, before anything is recorded or signed. |
| "Paid" means `receipt.status === success`. | A reverted transaction still costs gas and still lands on-chain. |
| A missing transaction is dead only once its nonce is spent, and the nonce is read *before* the receipt. | The reverse order could declare a transaction dead in the instant it is included, and rebuilding it would pay twice. |
| Vault USDC and operator gas are tracked separately. | A full vault with an operator out of gas stops silently. |

These are proven against a real EVM node with the real vault in [`packages/payments/test/integration/arc-anvil.test.ts`](packages/payments/test/integration/arc-anvil.test.ts): double send, replayed batch id, blocked recipient, spent nonce. A smoke script ([`scripts/arc-smoke.mjs`](scripts/arc-smoke.mjs)) runs the whole loop against a live server: sign in, deposit, credit, campaign, withdraw from the vault, verify on-chain.

## Identity is a wallet

Publishers and advertisers sign in by signing a plain-text message with any EIP-1193 wallet (MetaMask, Rabby, Coinbase Wallet; discovered via EIP-6963). `personal_sign` prefixes the message per EIP-191, so the signature can never be a transaction. The server recovers the signer and issues a token. The publisher id *is* the EIP-55 checksummed address, so the same wallet signing in with lowercase and checksummed spellings is one account, not two.

Address policy rejects pasted private keys and mnemonics (without echoing them), contracts (funds could be locked, and they cannot sign in), the USDC and vault addresses themselves, and addresses blocked by the USDC issuer.

## Architecture

```
Claude Code
    │  hooks: UserPromptSubmit → Stop
    ▼
statusLine shim ──22ms──> lulld ──> turn state machine
    │                        │            │
    └──── ✶ Sponsor … ───────┘       disk queue
                                          │
                                          ▼
                                   Lull backend ──> Arc (USDC, LullVault)
```

The daemon holds the ad in memory so the shim never touches the network. If the daemon is down, unreachable, or unsure, the shim prints **nothing**: no error, no stale line. It fails closed.

## Design principles

**Disclosure is not optional.** Every surface, including the spinner verb, starts with `✶`. An ad is never formatted to look like the tool's own output.

**Ad copy is hostile input.** A creative containing control characters is treated as an attack attempt. It is rejected, not sanitized and served. Tests cover 20 attack vectors, from OSC 52 clipboard writes to bidi override.

**Only what is measured is billed.** The ad is shown only during an active turn plus a short grace period.

**Money is integers.** Amounts are branded `bigint` micro-USDC (1e-6), the precision of Arc's USDC ERC-20 interface, so ledger amounts and on-chain amounts are the same number. Native USDC (gas) has 18 decimals and is never mixed into the ledger. Floats are banned. The ledger is double-entry.

## Repo layout

```
contracts/vault/        LullVault (Solidity, Foundry) — built with Arc Studio
packages/protocol/      shared types, money, sanitizer, schemas
packages/payments/      ArcRail, deposit source, address policy, wallet sign-in, payout job
packages/server/        HTTP API, ledger, ad selection, deposits, withdrawals, web panels
packages/cli/           daemon, unix socket, shim, disk queue, `lull` command
scripts/arc-smoke.mjs   end-to-end money loop against a live server
spikes/                 throwaway probes (ad-surface measurements)
PROJECT.md              design document — ADRs, data model
```

## Development

```bash
pnpm install
pnpm test              # unit tests across all packages
pnpm typecheck
pnpm test:contracts    # forge test (needs Foundry; see contracts/vault/README.md)

# rail against a real EVM node + the real vault (needs Foundry)
(cd contracts/vault && forge build)
LULL_ANVIL=1 pnpm --filter @lull/payments test
```

Run the server locally (in-memory database, Arc testnet):

```bash
pnpm --filter @lull/server build
PORT=8787 node packages/server/dist/server.mjs
```

See [`.env.example`](.env.example) for every variable, and [`contracts/vault/README.md`](contracts/vault/README.md) for deploying the vault.

## Verification status

| Area | Status |
|---|---|
| Unit tests (protocol, payments, server, CLI) | ✅ 718 pass |
| `LullVault` Foundry tests (unit + invariant) | ✅ 40 pass |
| `ArcRail` + deposit source against anvil with the real vault | ✅ 7 pass |
| Full money loop (login → deposit → credit → campaign → withdraw from vault) on a local chain | ✅ |
| Vault deployed on Arc testnet from Arc Studio | ✅ `0x2a7db15f85f947b7374847382b00133d470d6eda` |
| Vault deployed on Arc mainnet | ✅ [`0x6f3f3008eb689F2f0AC82dC08bBBb5Fc3ECc15c5`](https://explorer.arc.io/address/0x6f3f3008eb689F2f0AC82dC08bBBb5Fc3ECc15c5) (tx [`0x7f54f795…`](https://explorer.arc.io/tx/0x7f54f7955f06aa1383858fa290295545ebc2f695841a113be775f50dbdc7213c)) |
| Live server on Arc mainnet | ✅ https://lullserver-production.up.railway.app |
| Money loop with real USDC on mainnet (`scripts/arc-smoke.mjs`) | ✅ deposit [`0x786c6a1b…`](https://explorer.arc.io/tx/0x786c6a1b1cd2aa394efe188246709294a2d4c9d31633c27c700aae89d7ce35a0) credited in 13s → campaign → vault payout [`0xeaf637b2…`](https://explorer.arc.io/tx/0xeaf637b21d7a92c4358d79dc3c334efe637c4e8728d800788b260b103bbf3892) |
