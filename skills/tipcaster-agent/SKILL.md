---
name: tipcaster-agent
version: 1.0.0
description: Run the TipCaster OpenClaw agent to post a Farcaster prompt, pick a winner, and send 0.1 USDC on Base.
metadata:
  openclaw:
    emoji: "🦞"
    documentation: "Uses src/agent.js to execute the TipCaster daily cycle."
    requires:
      bins:
        - node
---

# TipCaster Agent Skill

When asked to run the TipCaster agent, execute the script once and return the result. Do not run any other commands.

## Steps
1. Call the exec tool with:
   - command: `node {baseDir}/../../src/agent.js`
   - workdir: `{baseDir}/../..`
2. If the command fails due to missing environment variables, report the missing env names and stop.

## Environment
The script reads its configuration from environment variables (or a `.env` file in the repo root). Required keys:
- `BASE_RPC_URL`
- `PRIVATE_KEY`
- `USDC_ADDRESS`
- `NEYNAR_API_KEY`
- `NEYNAR_SIGNER_UUID`

Optional:
- `USDC_DECIMALS`
- `USDC_AMOUNT`
- `PAYOUT_AFTER_HOURS`
- `BASESCAN_TX_BASE_URL`
- `PROMPT_TEXT`
- `RESULT_TEXT_TEMPLATE`
