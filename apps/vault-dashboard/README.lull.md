# Lull Vault dashboard

Built in Arc Studio (same project as the vault: https://studio.arc.io/app/115f0ad4-c41f-4e3a-b5d5-28b2d1cc27ea) from [`STUDIO-PROMPT.md`](STUDIO-PROMPT.md), then pulled here with `arc-studio pull`. It reads `LullVault` on Arc mainnet directly from the public RPC (stats, Paid/BatchPaid/Deposited events, USDC transfers in) and lets anyone fund the vault from their wallet with one USDC transfer.

Live at https://lullserver-production.up.railway.app/vault/

```bash
npm install --legacy-peer-deps
npx vite build                      # base path /vault/
cp -R dist ../../packages/server/public/vault
```

The only local change after the pull is `base: '/vault/'` in `vite.config.ts`.
