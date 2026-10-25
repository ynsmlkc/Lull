Now build the app for this project: a public dashboard for the vault, deployed on Arc MAINNET. Do not deploy any new contract — the vault is already live on Arc mainnet and you must call it.

Context: the project was renamed from Linger to Lull. Rename the contract in this workspace to LullVault (file, contract name, tests) without changing any logic. The mainnet instance of exactly this code is:
- LullVault: 0x6f3f3008eb689F2f0AC82dC08bBBb5Fc3ECc15c5 on Arc mainnet (chain id 5042, RPC https://rpc.mainnet.arc.io, explorer https://explorer.arc.io), deployed at block 27826765
- USDC (ERC-20 interface, 6 decimals): 0x3600000000000000000000000000000000000000. Native gas is also USDC (18 decimals) — never mix the two.

Build a single-page React app (the Vite app in this workspace) called "Lull Vault":
1. Header: "Lull — ads for AI coding tools, paid in USDC on Arc". Link to https://lullserver-production.up.railway.app and https://github.com/ynsmlkc/Lull.
2. Live vault stats read from Arc mainnet: USDC held (balance()), operator(), owner(), paused(). Refresh every 15s.
3. Activity feed: the latest Paid, BatchPaid, Deposited events plus USDC Transfer events into the vault, read from block 27826765 onward in chunks of at most 10,000 blocks. Each row links to explorer.arc.io/tx/<hash>. Show amounts in USDC (6 decimals).
4. "Fund the vault" card: connect an injected wallet (EIP-1193 / EIP-6963: MetaMask, Rabby, Coinbase Wallet), switch to Arc mainnet (wallet_addEthereumChain with chain id 5042, native currency USDC 18 decimals, RPC and explorer above), enter an amount, and send ERC-20 USDC transfer(vault, amount) — one transaction. Show the tx hash with an explorer link. Explain that deposits are credited to the sender's Lull advertiser account, so the user should send from the wallet they sign in with at lullserver-production.up.railway.app/advertisers/app.
5. Clean dark UI, works at phone width. No backend needed; read via public RPC.

Test the read paths against mainnet in the sandbox and confirm the stats render with real values (balance should be about 0.5 USDC). Report what you verified.
