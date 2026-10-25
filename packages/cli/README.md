# lingersh-arc

Turn the waiting into earnings.

When you ask Claude Code something, one sponsored line of text sits in your
status line while the model works. When the answer arrives, it is gone. You
get paid in USDC on Solana.

```
npm i -g lingersh-arc && linger init --spinner
```

After install, the command is `linger`.

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
npm i -g lingersh-arc && linger init --spinner             # install and start
linger init --spinner   # also use the "Thinking…" words at the top
```

Then open a new Claude Code session.

## Getting paid

```bash
linger login      # connect your wallet — earnings go here
linger balance    # what you have earned
```

`linger login` opens a page on your own machine and you sign a message with Phantom, Solflare or Backpack.
**Your private key never enters this tool.**

Your identity *is* your wallet address. No GitHub, no email, no password.

## Commands

| Command | What it does |
|---|---|
| `linger init` | install and start |
| `linger login` | connect your wallet |
| `linger balance` | show earnings |
| `linger whoami` | show the connected wallet |
| `linger status` | daemon status |
| `linger doctor` | diagnose the install |
| `linger restart` | restart the daemon |
| `linger pause` / `resume` | stop showing ads for now |
| `linger logout` | disconnect the wallet |
| `linger uninstall` | remove it |

## Leaving

```bash
linger uninstall
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

Without a server connection `linger` shows sample ads and **records no
earnings**. `linger init` tells you when that is the case.

## Links

- [github.com/ynsmlkc/Linger](https://github.com/ynsmlkc/Linger)

## License

MIT
