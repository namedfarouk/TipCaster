# Base USDC Tip Bot (Farcaster)

Autonomous Farcaster agent that posts a daily prompt, picks a random reply containing a Base address, and sends 0.1 USDC on Base. No human in the loop.

## What it does
- Posts a prompt asking for a Base address.
- After a configurable delay, selects a winner from replies.
- Sends 0.1 USDC on Base using realtime gas.
- Posts the transaction hash and BaseScan link as proof.

## Setup

### 1) Install
```bash
npm install
```

### 2) Configure
Copy `.env.example` to `.env` and fill in values:

- `BASE_RPC_URL`: Base RPC provider URL.
- `PRIVATE_KEY`: bot wallet (fund with ETH for gas and USDC).
- `USDC_ADDRESS`: native USDC on Base.
- `NEYNAR_API_KEY`: Neynar API key.
- `NEYNAR_SIGNER_UUID`: Farcaster signer UUID for the bot account.

Optional:
- `PROMPT_TEXT`: custom prompt text.
- `RESULT_TEXT_TEMPLATE`: custom result text.
- `CYCLE_TZ`: timezone for daily cycle (default UTC).
- `PAYOUT_AFTER_HOURS`: how long to wait before settling a cycle (default 3).
- `BASESCAN_TX_BASE_URL`: BaseScan tx URL prefix.

### 3) Dry run (optional)
```bash
DRY_RUN=true npm run start
```

### 4) Run once
```bash
npm run start
```

### 5) Schedule (same-day payout)
To get same-day payouts, run the agent more than once per day. Example hourly crontab:
```bash
0 * * * * /usr/bin/node /absolute/path/to/project/src/agent.js >> /absolute/path/to/project/agent.log 2>&1
```

## OpenClaw integration (Builder Quest)

OpenClaw is required for the contest. This repo includes an OpenClaw skill at `skills/tipcaster-agent/SKILL.md`.

### 1) Install OpenClaw
```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

### 2) Load the skill
Add this repo's skills directory to your OpenClaw config (example `~/.openclaw/openclaw.json`):
```json
{
  "skills": {
    "load": {
      "extraDirs": ["/absolute/path/to/tipcaster-agent/skills"]
    },
    "entries": {
      "tipcaster-agent": {
        "env": {
          "BASE_RPC_URL": "...",
          "PRIVATE_KEY": "...",
          "USDC_ADDRESS": "...",
          "NEYNAR_API_KEY": "...",
          "NEYNAR_SIGNER_UUID": "..."
        }
      }
    }
  }
}
```

If you already have a `.env` file in the repo root and the skill runs with `workdir` set to the repo root, you can skip the `skills.entries` block and rely on `dotenv`.

### 3) Schedule with OpenClaw cron
Example hourly schedule using the main session (no human in the loop):
```bash
openclaw cron add \\
  --name "TipCaster Hourly" \\
  --cron "0 * * * *" \\
  --tz "UTC" \\
  --session main \\
  --system-event "Run the tipcaster-agent skill now. Do not ask questions."
```

## Notes
- If no replies are found, it skips the payout and starts a new prompt.
- Same-day payouts depend on your schedule frequency and `PAYOUT_AFTER_HOURS`.

## Security
- Use a dedicated wallet for the bot.
- Keep the wallet low-balance.
- Store `.env` securely and never commit it.
