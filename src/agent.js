import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { ethers } from "ethers";

const REQUIRED_ENV = [
  "BASE_RPC_URL",
  "PRIVATE_KEY",
  "USDC_ADDRESS",
  "NEYNAR_API_KEY",
  "NEYNAR_SIGNER_UUID",
];

const USDC_DECIMALS = Number(process.env.USDC_DECIMALS || 6);
const USDC_AMOUNT = process.env.USDC_AMOUNT || "0.1";
const NEYNAR_BASE_URL = process.env.NEYNAR_BASE_URL || "https://api.neynar.com";
const CYCLE_TZ = process.env.CYCLE_TZ || "UTC";
const STATE_PATH = process.env.STATE_PATH || "./data/state.json";
const PAYOUT_AFTER_HOURS = Number(process.env.PAYOUT_AFTER_HOURS || 3);
const BASESCAN_TX_BASE_URL =
  process.env.BASESCAN_TX_BASE_URL || "https://basescan.org/tx/";
const DRY_RUN = toBool(process.env.DRY_RUN || "false");
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const PROMPT_TEXT =
  process.env.PROMPT_TEXT ||
  "Drop a Base address (0x...) for today's 0.1 USDC tip. One entry per address. Winner picked automatically in ~24h.";

const RESULT_TEXT_TEMPLATE =
  process.env.RESULT_TEXT_TEMPLATE ||
  "Winner: {address} | Sent 0.1 USDC on Base | Tx: {txUrl}";

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function decimals() view returns (uint8)",
];

function log(level, message, meta = {}) {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  if (levels[level] <= (levels[LOG_LEVEL] ?? 2)) {
    const line = {
      time: new Date().toISOString(),
      level,
      message,
      ...meta,
    };
    console.log(JSON.stringify(line));
  }
}

function toBool(value) {
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function assertEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

function getCycleKey(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: CYCLE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date);
}

function hoursSince(isoString) {
  if (!isoString) return Number.NaN;
  const then = new Date(isoString);
  if (Number.isNaN(then.getTime())) return Number.NaN;
  const diffMs = Date.now() - then.getTime();
  return diffMs / (1000 * 60 * 60);
}

function extractAddresses(text) {
  const matches = text.match(/0x[a-fA-F0-9]{40}/g) || [];
  const unique = new Set();
  for (const match of matches) {
    try {
      const checksum = ethers.getAddress(match);
      unique.add(checksum);
    } catch {
      // ignore invalid
    }
  }
  return Array.from(unique);
}

async function neynarRequest({ path, method = "GET", query, body }) {
  const url = new URL(path, NEYNAR_BASE_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      api_key: process.env.NEYNAR_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`Neynar request failed: ${res.status} ${res.statusText} ${JSON.stringify(data)}`);
  }

  return data;
}

async function postCast({ text, parentHash }) {
  const body = {
    signer_uuid: process.env.NEYNAR_SIGNER_UUID,
    text,
  };

  if (parentHash) {
    body.parent_hash = parentHash;
    body.parent = { hash: parentHash };
  }

  const data = await neynarRequest({ path: "/v2/farcaster/cast", method: "POST", body });
  const hash = data?.cast?.hash || data?.result?.cast?.hash || data?.hash;

  if (!hash) {
    throw new Error(`Unable to read cast hash from response: ${JSON.stringify(data)}`);
  }

  return hash;
}

async function fetchReplies(parentHash) {
  const data = await neynarRequest({
    path: "/v2/farcaster/replies",
    method: "GET",
    query: {
      parent_hash: parentHash,
      hash: parentHash,
      limit: 100,
    },
  });

  const casts =
    data?.casts ||
    data?.replies ||
    data?.result?.casts ||
    data?.result?.replies ||
    [];

  if (!Array.isArray(casts)) {
    log("warn", "Unexpected replies payload", { payload: data });
    return [];
  }

  return casts.map((cast) => ({
    hash: cast?.hash,
    text: cast?.text || "",
  }));
}

async function pickWinner({ addresses, promptHash, provider }) {
  const block = await provider.getBlock("latest");
  const seed = ethers.keccak256(
    ethers.toUtf8Bytes(`${promptHash}|${block?.hash || ""}|${addresses.join(",")}`)
  );
  const index = Number(BigInt(seed) % BigInt(addresses.length));
  return addresses[index];
}

async function sendUsdc({ wallet, to }) {
  const contract = new ethers.Contract(process.env.USDC_ADDRESS, ERC20_ABI, wallet);
  const amount = ethers.parseUnits(USDC_AMOUNT, USDC_DECIMALS);
  const feeData = await wallet.provider.getFeeData();

  const tx = await contract.transfer(to, amount, {
    maxFeePerGas: feeData.maxFeePerGas ?? undefined,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
  });

  return tx;
}

async function settleCycle({ state, provider, wallet }) {
  if (!state.prompt_cast_hash) {
    log("warn", "No prompt cast hash to settle");
    return state;
  }

  if (state.tx_hash) {
    log("info", "Cycle already settled", { tx_hash: state.tx_hash });
    return state;
  }

  const replies = await fetchReplies(state.prompt_cast_hash);
  const botAddress = await wallet.getAddress();
  const candidates = new Set();

  for (const reply of replies) {
    for (const addr of extractAddresses(reply.text)) {
      if (addr.toLowerCase() !== botAddress.toLowerCase()) {
        candidates.add(addr);
      }
    }
  }

  const addressList = Array.from(candidates);
  if (addressList.length === 0) {
    log("info", "No eligible replies found", { prompt_cast_hash: state.prompt_cast_hash });
    return {
      ...state,
      no_winner: true,
      settled_at: new Date().toISOString(),
    };
  }

  const winner = await pickWinner({ addresses: addressList, promptHash: state.prompt_cast_hash, provider });
  log("info", "Winner selected", { winner, count: addressList.length });

  if (DRY_RUN) {
    log("info", "DRY_RUN enabled; skipping transfer");
    state.winner_address = winner;
    state.tx_hash = "DRY_RUN";
    return state;
  }

  const tx = await sendUsdc({ wallet, to: winner });
  log("info", "USDC transfer sent", { tx_hash: tx.hash });

  const txUrl = `${BASESCAN_TX_BASE_URL}${tx.hash}`;
  const resultText = RESULT_TEXT_TEMPLATE.replace("{address}", winner).replace("{txHash}", tx.hash).replace(
    "{txUrl}",
    txUrl
  );
  try {
    await postCast({ text: resultText, parentHash: state.prompt_cast_hash });
  } catch (err) {
    log("warn", "Failed to post result cast", { error: String(err) });
  }

  return {
    ...state,
    winner_address: winner,
    tx_hash: tx.hash,
    tx_url: txUrl,
    settled_at: new Date().toISOString(),
  };
}

async function startNewCycle({ state }) {
  const promptHash = await postCast({ text: PROMPT_TEXT });
  const cycleKey = getCycleKey();

  log("info", "Posted new prompt", { prompt_cast_hash: promptHash, cycle: cycleKey });

  return {
    cycle_key: cycleKey,
    prompt_cast_hash: promptHash,
    created_at: new Date().toISOString(),
    tx_hash: null,
    winner_address: null,
  };
}

async function main() {
  if (process.argv.includes("--self-check")) {
    assertEnv();
    console.log("env_ok");
    return;
  }

  assertEnv();

  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  let state = await loadState();
  const todayKey = getCycleKey();

  if (!state.cycle_key) {
    log("info", "Initializing new cycle");
    state = await startNewCycle({ state });
    await saveState(state);
    return;
  }

  const ageHours = hoursSince(state.created_at);
  const readyToSettle = Number.isFinite(ageHours) && ageHours >= PAYOUT_AFTER_HOURS;

  if (readyToSettle && !state.tx_hash) {
    log("info", "Payout window reached, settling cycle", {
      cycle_key: state.cycle_key,
      age_hours: ageHours.toFixed(2),
      payout_after_hours: PAYOUT_AFTER_HOURS,
    });

    state = await settleCycle({ state, provider, wallet });
    state = await startNewCycle({ state });
    await saveState(state);
    return;
  }

  log("info", "Waiting for payout window", {
    cycle_key: state.cycle_key ?? todayKey,
    age_hours: Number.isFinite(ageHours) ? ageHours.toFixed(2) : null,
    payout_after_hours: PAYOUT_AFTER_HOURS,
  });
}

main().catch((err) => {
  log("error", "Agent crashed", { error: String(err), stack: err?.stack });
  process.exit(1);
});
