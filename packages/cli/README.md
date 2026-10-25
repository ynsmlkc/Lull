# lullsh

Turn the waiting into earnings.

When you ask Claude Code something, one sponsored line of text sits in your
status line while the model works. When the answer arrives, it is gone. You
get paid in USDC on Solana.

```
npm i -g lullsh && lull init --spinner
```

After install, the command is `lull`.

---

## What it looks like

```
✶ Firecrawl — docs to LLM-ready markdown · firecrawl.dev        Edit · 2.8s
```

One line, plain text, in the status line at the bottom of Claude Code. It
shows **only while you are waiting** — it disappears when the answer lands,
and an idle terminal shows nothing at all.

That is the only condition: you have to be waiting. No waiting, no line, no
impression, no payment.

## Install

```bash
npm i -g lullsh && lull init --spinner             # install and start
lull init --spinner   # also use the "Thinking…" words at the top
```

Then open a new Claude Code session.

## Getting paid

```bash
lull login      # connect your wallet — earnings go here
lull balance    # what you have earned
```

`lull login` opens a page on your own machine and you sign a message with Phantom, Solflare or Backpack.
**Your private key never enters this tool.**

Your identity *is* your wallet address. No GitHub, no email, no password.

## Commands

| Command | What it does |
|---|---|
| `lull init` | install and start |
| `lull login` | connect your wallet |
| `lull balance` | show earnings |
| `lull whoami` | show the connected wallet |
| `lull status` | daemon status |
| `lull doctor` | diagnose the install |
| `lull restart` | restart the daemon |
| `lull pause` / `resume` | stop showing ads for now |
| `lull logout` | disconnect the wallet |
| `lull uninstall` | remove it |

## Leaving

```bash
lull uninstall
```

It removes only our own entries. If you have your own settings in
`settings.json`, they are left exactly as they were — we do not restore from a
backup, because that would silently undo changes you made after the backup was
taken.

## What we send

Being clear about this matters: if a tool installs something on your machine,
you should know what it sees.

**We send:** impression id, campaign id, duration, session id, client version,
OS and architecture.

**We never send:** your directory paths, your file names, your prompts, your
code. The value used to tell projects apart is hashed with a salt generated on
your machine that never leaves it — raw paths never reach the network.

## Things you should know

Claude Code hides some of the keyboard hints at the bottom (like
`esc to interrupt`) while a custom `statusLine` is defined. That is Claude
Code's behaviour, not our choice — but you are the one who lives with it, so we
say it up front.

With `--spinner`, the "Thinking…" words at the top change too. That field
accepts one list at a time, so if another tool writes to it as well, one of you
overwrites the other.

## Status

Devnet. The payout code is implemented and unit-tested; it has not yet been
run against Solana devnet, and mainnet is out of scope for now.

Without a server connection `lull` shows sample ads and **records no
earnings**. `lull init` tells you when that is the case.

## Links

- [github.com/ynsmlkc/Lull](https://github.com/ynsmlkc/Lull)

## License

MIT
