<div align="center">

# CogniTrader BSC

### Multi-Signal AI Trading Agent on BNB Chain

**BNB Hack 2026 — Track 1: Autonomous Trading Agents ($24,000 Prize)**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Ethers.js](https://img.shields.io/badge/Ethers.js-v6-7C3AED?logo=ethereum&logoColor=white)](https://ethers.org/)
[![BNB Chain](https://img.shields.io/badge/BNB_Chain-56-F3BA2F?logo=binance&logoColor=white)](https://www.bnbchain.org/)
[![CoinMarketCap](https://img.shields.io/badge/CoinMarketCap-API-00A699)](https://coinmarketcap.com/api/)
[![TWAK](https://img.shields.io/badge/Trust_Wallet_Agent_Kit-TWAK-3375BB?logo=trustwallet&logoColor=white)](https://trustwallet.com/)
[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

*Autonomous, non-custodial, multi-signal trading agent that runs continuously on BNB Smart Chain*

[Features](#features) &middot; [Architecture](#architecture) &middot; [Strategies](#strategies) &middot; [Risk Management](#risk-management) &middot; [Quick Start](#getting-started) &middot; [Configuration](#configuration) &middot; [Roadmap](#roadmap)

</div>

---

## Overview

**CogniTrader BSC** is a fully autonomous AI trading agent built for the BNB Smart Chain. It continuously monitors market data from CoinMarketCap, generates multi-signal trade recommendations using three complementary strategies, enforces strict risk management guardrails, and executes trades non-custodially via PancakeSwap — all orchestrated through the Trust Wallet Agent Kit (TWAK) and BNB AI Agent SDK.

### Why CogniTrader Wins

Most trading bots use a single indicator or simple threshold logic. CogniTrader combines **three independent strategy engines** (Momentum, Sentiment, Mean Reversion) into a weighted composite signal, requiring multi-factor consensus before acting. The agent never blindly follows one signal — it demands agreement across technical, fundamental, and statistical dimensions.

The architecture is **non-custodial by design**: your private key never leaves the agent process, and TWAK's policy engine can enforce hard limits on trade sizes, allowed tokens, and daily exposure — even adding manual confirmation requirements for high-value transactions. The BNB AI Agent SDK provides persistent memory (learning from past trades) and a tool registry that enables the agent to reason about risk, position sizing (Kelly Criterion), and market regime.

CogniTrader ships production-ready with Docker support, structured logging (Winston), health checks, graceful shutdown, dry-run mode for safe testing, and a `bash` launcher with pre-flight validation. Over **3,500 lines of TypeScript** across 15 source files, with full type safety and zero dependencies on paid ML APIs.

---

## Features

- **3 Independent Strategy Engines** — Momentum (RSI + MACD + Volume), Sentiment (CMC Fear&Greed divergence), Mean Reversion (z-score + Bollinger Bands)
- **Weighted Signal Aggregation** — BNB AI Agent SDK orchestrates signals with configurable strategy weights (40/35/25) and consensus logic
- **Non-Custodial Execution** — TWAK policy engine + Ethers.js v6 for PancakeSwap swaps on BSC
- **Strict Risk Guardrails** — Max 10% position size, 5% stop-loss, 15% take-profit, 3 concurrent positions, 10% daily drawdown circuit breaker
- **Agent Memory** — Persistent short-term and long-term trade memory with disk persistence across restarts
- **Market Regime Awareness** — Fear & Greed Index filters adjust signal confidence in extreme market conditions
- **Production Hardened** — Docker multi-stage build, docker-compose, health checks, structured logging, graceful shutdown
- **Dry-Run Mode** — Full simulation with no real trades for safe testing and backtesting preparation

---

## Architecture

```
                         CogniTrader BSC Agent Loop
    ┌──────────────────────────────────────────────────────────┐
    │                                                          │
    │  ┌─────────┐    ┌──────────┐    ┌───────────┐           │
    │  │ CoinMarketCap│──▶│  Signal   │──▶│   BNB AI  │           │
    │  │   API      │    │  Engine   │    │ Agent SDK │           │
    │  │            │    │          │    │           │           │
    │  │ - Quotes   │    │ Momentum │    │ Orchestrate│          │
    │  │ - Fear/Greed│   │ Sentiment │    │ Composite │           │
    │  │ - Trending │    │ MeanRev  │    │ Score     │           │
    │  └─────────┘    └──────────┘    │ Memory    │           │
    │                                  └─────┬─────┘           │
    │                                        │                  │
    │                                        ▼                  │
    │  ┌─────────┐    ┌──────────┐    ┌───────────┐           │
    │  │ PancakeSwap│◀──│ Strategy │◀──│   Risk    │           │
    │  │   (BSC)    │    │  Engine  │    │  Manager  │           │
    │  │            │    │          │    │           │           │
    │  │ - Swap     │    │ Position │    │ Max Size  │           │
    │  │ - Price    │    │ Tracking │    │ Stop-Loss │           │
    │  │ - Balance  │    │ Execution │    │ Drawdown  │           │
    │  └─────┬──────┘    └──────────┘    └───────────┘           │
    │        │                                                  │
    │        ▼                                                  │
    │  ┌─────────┐    ┌──────────┐    ┌───────────┐             │
    │  │ TWAK     │───▶│ Monitor  │───▶│   Next    │             │
    │  │ Policy   │    │  & Log   │    │  Cycle    │             │
    │  │ Engine   │    │ Metrics  │    │ (30s loop) │             │
    │  └─────────┘    └──────────┘    └───────────┘             │
    │                                                          │
    └──────────────────────────────────────────────────────────┘
```

### Data Flow (Per Cycle)

```
1. FETCH     CoinMarketCap API → Market Snapshot (quotes + Fear&Greed + trending)
2. ANALYZE   Each token → 3 strategies generate independent signals
3. AGGREGATE BNB AI Agent SDK → Weighted composite score + consensus direction
4. FILTER    Minimum score threshold (65) + WEAK signal rejection
5. RISK      Position sizing, max positions, drawdown check, duplicate detection
6. POLICY    TWAK allowed tokens, max tx value, confirmation mode
7. EXECUTE   BSC on-chain swap via PancakeSwap (Ethers.js v6)
8. MONITOR   Track positions, evaluate stop-loss/take-profit, update metrics
9. LOG       Structured logs to console + file, persist agent memory
10. REPEAT   Wait for polling interval, start next cycle
```

---

## Strategies

### 1. Momentum Strategy (RSI + MACD + Volume)

**Weight: 40%** | Minimum data: 30 candles

Combines four technical indicators into a 100-point composite score:

| Component | Max Points | Logic |
|-----------|-----------|-------|
| **RSI (14-period)** | 30 | Oversold (≤30) = strong buy signal, Overbought (≥70) = sell signal |
| **MACD (12/26/9)** | 30 | Bullish crossover (histogram > 0, MACD > 0) = 28pts; bearish = 5pts |
| **Volume Profile** | 25 | Volume surge (>2.5x SMA) with increasing trend = explosive confirmation |
| **Price Momentum** | 15 | 5-candle price change; >8% = strong upward, <-8% = strong downward |

**Direction logic**: Score ≥70 → LONG, Score ≤40 → SHORT, otherwise HOLD

**Regime filter**: In Extreme Fear (F&G ≤20), LONG signals get caution warnings. In Extreme Greed (F&G ≥80), SHORT signals get caution warnings.

### 2. Sentiment Strategy (CMC Fear&Greed Divergence)

**Weight: 35%** | Minimum data: CMC quote + Fear&Greed index

A data-driven sentiment strategy using CoinMarketCap's proprietary Fear & Greed Index and market performance data:

| Component | Max Points | Logic |
|-----------|-----------|-------|
| **Price Performance** | 35 | Multi-timeframe scoring (1h, 24h, 7d) + bullish divergence detection |
| **Volume Sentiment** | 25 | Volume/market-cap ratio + CMC rank-based liquidity scoring |
| **Fear & Greed Alignment** | 25 | Contrarian: buy in fear (≤25 = +20pts), sell in greed (≥75 = +15pts) |
| **Trending Boost** | 25 | CMC trending tokens get momentum bonus based on 24h performance |

**Key insight**: Detects bullish divergence when 1h performance is positive but 24h is negative — a classic early reversal signal worth +8 bonus points.

### 3. Mean Reversion Strategy (Statistical Z-Score)

**Weight: 25%** | Minimum data: 20 candles

A statistical approach assuming prices revert to their historical mean:

| Component | Max Points | Logic |
|-----------|-----------|-------|
| **Bollinger Bands** | 35 | %B position; ≤5 = extremely oversold (+20pts), ≥95 = overbought (-15pts) |
| **Z-Score** | 25 | Extreme deviation from 30-candle mean; ≤-2.5σ = strong buy (+13pts) |
| **Wick Rejection** | 20 | Candlestick lower wick analysis; lower wick dominance = bullish rejection |
| **MAD Volatility** | 20 | Mean Absolute Deviation ratio; lower volatility = more reliable reversion |

**Regime filter**: Mean reversion is less reliable in extreme markets (F&G ≤15 or ≥85), and the agent adds caution notes.

---

## Risk Management

CogniTrader enforces **6 layers of risk protection** before any trade reaches the blockchain:

### Hard Limits (Non-Negotiable)

| Parameter | Default | Safety Cap |
|-----------|---------|------------|
| Max Position Size | 10% of portfolio | 20% |
| Stop-Loss | 5% loss | 15% |
| Take-Profit | 15% gain | — |
| Max Concurrent Positions | 3 | 5 |
| Daily Drawdown Limit | 10% | 20% |
| Slippage Tolerance | 50 bps (0.5%) | — |

### Risk Assessment Pipeline

```
1. Max Concurrent Positions  → Reject if at limit
2. Daily Drawdown Circuit    → Halt all trading if daily loss exceeds limit
3. Position Size Check       → Cap trade to min(proposed, max_position_pct)
4. Signal Quality Gate       → Reject if composite score < minSignalScore (65)
5. Confidence Threshold      → Warn if avg confidence < minConfidence (0.6)
6. Balance Verification      → Reject if insufficient BNB for trade + gas
7. Duplicate Detection        → Reject if already holding position in token
```

### Portfolio Heat Tracking

The risk manager calculates **portfolio heat** — the maximum possible loss if all stop-losses trigger simultaneously. This is:

```
Heat = Σ(position_value × stop_loss_pct) / total_portfolio
```

### Kelly Criterion Position Sizing

For adaptive position sizing, CogniTrader implements the **Half-Kelly Criterion**:

```
Kelly = win_rate - ((1 - win_rate) / (avg_win / avg_loss))
Position = min(Kelly × 0.5 × portfolio, max_position_cap)
```

Half-Kelly is used instead of full Kelly for additional safety margin, reducing variance while maintaining most of the expected growth rate.

### TWAK Policy Engine (Non-Custodial Guardrails)

An additional layer via Trust Wallet Agent Kit:

- **Allowed tokens whitelist** — Only tokens in the configured list can be traded
- **Max transaction value** — Hard cap per transaction in BNB
- **Confirmation mode** — Require manual approval for trades (autonomous mode toggle)
- **Daily spend limit** — Cumulative daily limit across all transactions

---

## Getting Started

### Prerequisites

- **Node.js** 18+ (LTS recommended)
- **BNB** for gas fees on BSC mainnet (or testnet BNB for testing)
- **CoinMarketCap API key** — [Get one here](https://pro.coinmarketcap.com/)
- **BSC wallet** with private key (MetaMask export or new wallet)

### Installation

```bash
# Clone the repository
git clone https://github.com/Cubiczan/cognitrader-bsc.git
cd cognitrader-bsc

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your credentials
nano .env
```

### Environment Variables

```bash
# ─── Required ──────────────────────────────────────
BSC_RPC_URL=https://bsc-dataseed.binance.org   # BSC RPC endpoint
BSC_WALLET_ADDRESS=0x...                        # Your BSC wallet address
BSC_PRIVATE_KEY=0x...                           # Your private key (NEVER commit)
CMC_API_KEY=your_cmc_api_key                    # CoinMarketCap API key

# ─── Recommended ───────────────────────────────────
AGENT_DRY_RUN=true          # Start in simulation mode (safe!)
AGENT_TOKENS=CAKE,ETH,ADA   # Tokens to monitor and trade
AGENT_STRATEGIES=MOMENTUM,SENTIMENT,MEAN_REVERSION

# ─── TWAK (Optional) ─────────────────────────────
TWAK_AUTONOMOUS_MODE=true   # Agent trades without manual approval
TWAK_POLICY_ENGINE=true     # Enable policy guardrails
```

> **Always start with `AGENT_DRY_RUN=true`** to verify the agent works correctly before enabling live trading.

### Run the Agent

```bash
# Development mode (TypeScript, dry-run, debug logs)
npm run dev

# Build and run production
npm run build
npm start

# Using the production launcher script
bash run-agent.sh dev       # Development mode
bash run-agent.sh dry-run   # Dry-run simulation
bash run-agent.sh run       # Live trading (!)
```

### Docker Deployment

```bash
# Build and run with docker-compose
docker-compose up --build -d

# View logs
docker-compose logs -f cognitrader

# Stop
docker-compose down
```

---

## TWAK Quick Start

The Trust Wallet Agent Kit (TWAK) provides non-custodial wallet management and policy enforcement. Set up in 3 commands:

```bash
# 1. Create a TWAK wallet for the agent
twak wallet create --chain bsc --json

# 2. Register for the BNB Hack competition
twak compete register --id bnb-hack-2026 --wallet <ADDRESS> --json

# 3. Verify the agent can sign transactions
twak tx sign --to 0x... --value 0.01 --data 0x --json

# Enable autonomous mode (no manual confirmations)
twak config set autonomous true
```

TWAK integration in CogniTrader provides:
- **Non-custodial signing** — Private keys never leave the TWAK wallet
- **Policy engine** — Hard limits on trade amounts and token whitelist
- **X402 payment protocol** — Machine-to-machine payment support
- **Competition registration** — Direct integration with BNB Hack leaderboard

---

## Configuration

All configuration is managed via environment variables (`.env` file) with sensible defaults:

### Agent Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_POLLING_INTERVAL` | `30000` | Milliseconds between trading cycles |
| `AGENT_MAX_POSITIONS` | `3` | Maximum concurrent open positions |
| `AGENT_MAX_POSITION_PCT` | `0.10` | Max position size as fraction of portfolio |
| `AGENT_STOP_LOSS_PCT` | `0.05` | Stop-loss threshold (5%) |
| `AGENT_TAKE_PROFIT_PCT` | `0.15` | Take-profit threshold (15%) |
| `AGENT_DAILY_DRAWDOWN_PCT` | `0.10` | Daily loss limit before halting (10%) |
| `AGENT_MIN_SIGNAL_SCORE` | `65` | Minimum composite score to act (0-100) |
| `AGENT_MIN_CONFIDENCE` | `0.6` | Minimum signal confidence (0-1) |
| `AGENT_SLIPPAGE_BPS` | `50` | Slippage tolerance in basis points |
| `AGENT_DRY_RUN` | `true` | Dry-run mode (no real trades) |
| `AGENT_STRATEGIES` | `MOMENTUM,SENTIMENT,MEAN_REVERSION` | Active strategies (comma-separated) |
| `AGENT_TOKENS` | `CAKE,ETH,ADA,SOL,AVAX` | Tokens to monitor (comma-separated) |
| `AGENT_LOG_LEVEL` | `info` | Logging level (debug/info/warn/error) |

### BSC Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BSC_RPC_URL` | — *(required)* | BSC JSON-RPC endpoint |
| `BSC_CHAIN_ID` | `56` | Chain ID (56=mainnet, 97=testnet) |
| `PANCAKESWAP_ROUTER` | `0x10ED43C7...` | PancakeSwap V2 Router address |
| `WBNB_ADDRESS` | `0xbb4CdB9...` | Wrapped BNB contract address |

### CMC Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CMC_API_KEY` | — *(required)* | CoinMarketCap Pro API key |
| `CMC_BASE_URL` | `https://pro-api.coinmarketcap.com` | API base URL |
| `CMC_RATE_LIMIT_MS` | `5000` | Rate limit between API calls |

### TWAK Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TWAK_WALLET_PATH` | `./wallet.json` | Path to TWAK wallet file |
| `TWAK_POLICY_ENGINE` | `true` | Enable policy guardrails |
| `TWAK_MAX_TX_BNB` | `5` | Max transaction value in BNB |
| `TWAK_ALLOWED_TOKENS` | `CAKE,BNB,BUSD,USDT,ETH,ADA,SOL,AVAX` | Token whitelist |
| `TWAK_REQUIRE_CONFIRMATION` | `false` | Require manual trade approval |
| `TWAK_AUTONOMOUS_MODE` | `true` | Fully autonomous (no confirmations needed) |

---

## Directory Structure

```
cognitrader-bsc/
├── src/
│   ├── index.ts                          # Main entry point + agent bootstrap
│   ├── agent/
│   │   ├── CogniTrader.ts                # Core agent orchestrator & main loop
│   │   ├── SignalEngine.ts                # Multi-strategy signal generation pipeline
│   │   ├── StrategyEngine.ts              # Trade execution & position management
│   │   └── RiskManager.ts                 # Risk assessment & position sizing
│   ├── strategies/
│   │   ├── MomentumStrategy.ts            # RSI + MACD + Volume momentum scoring
│   │   ├── SentimentStrategy.ts           # CMC Fear&Greed + divergence detection
│   │   └── MeanReversion.ts               # Z-score + Bollinger Bands reversion
│   ├── integrations/
│   │   ├── cmc.ts                         # CoinMarketCap API client
│   │   ├── bsc.ts                         # BSC on-chain interaction (Ethers.js v6)
│   │   ├── twak.ts                        # Trust Wallet Agent Kit integration
│   │   └── bnb-agent-sdk.ts              # BNB AI Agent SDK wrapper
│   ├── utils/
│   │   ├── types.ts                       # Full TypeScript type definitions
│   │   ├── config.ts                      # Configuration loader + validation
│   │   └── logger.ts                      # Winston structured logging
│   └── config/
│       └── default.json                   # Default agent configuration
├── .env.example                           # Environment variable template
├── .gitignore                             # Git ignore rules
├── Dockerfile                             # Multi-stage Docker build
├── docker-compose.yml                     # Docker Compose orchestration
├── run-agent.sh                           # Production launcher script
├── tsconfig.json                          # TypeScript configuration
├── package.json                           # Dependencies & scripts
├── LICENSE                                # MIT License
└── README.md                              # This file
```

---

## Roadmap

### Phase 1 — Foundation (Current) ✅

- [x] Multi-signal engine (Momentum + Sentiment + Mean Reversion)
- [x] Risk management with hard limits and circuit breakers
- [x] TWAK non-custodial integration
- [x] BNB AI Agent SDK orchestration with memory
- [x] PancakeSwap on-chain execution via Ethers.js v6
- [x] Docker + docker-compose deployment
- [x] Dry-run simulation mode
- [x] Structured logging and metrics

### Phase 2 — Backtesting & Analytics

- [ ] Historical backtesting engine using CMC OHLCV data
- [ ] Strategy performance dashboard (win rate, Sharpe ratio, max drawdown)
- [ ] Parameter optimization grid search
- [ ] Strategy weight auto-tuning based on recent performance
- [ ] Equity curve visualization and Monte Carlo simulation

### Phase 3 — Social & Advanced Features

- [ ] Social copy-trading — follow top-performing CogniTrader agents
- [ ] Multi-agent swarm mode — coordinate multiple agents with different risk profiles
- [ ] On-chain portfolio tracker — real-time PnL on a BNB Chain dashboard
- [ ] Telegram/Discord bot integration — alerts and remote commands
- [ ] Cross-chain expansion — Ethereum, Polygon, Arbitrum via TWAK

---

## Tech Stack

| Technology | Purpose |
|-----------|---------|
| **TypeScript 5.5** | Full type safety across 3,500+ lines |
| **Ethers.js v6** | BSC blockchain interaction, PancakeSwap swaps |
| **CoinMarketCap API** | Market data, Fear & Greed Index, trending tokens |
| **Trust Wallet Agent Kit** | Non-custodial signing, policy engine, X402 payments |
| **BNB AI Agent SDK** | Signal orchestration, agent memory, tool registry |
| **Winston** | Structured logging (console + file rotation) |
| **Docker** | Multi-stage build, health checks, production deployment |

---

## Supported BSC Tokens

Pre-configured token addresses for PancakeSwap trading:

| Symbol | Contract Address | Decimals |
|--------|----------------|----------|
| CAKE | `0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82` | 18 |
| ETH | `0x2170Ed0880ac9A755fd29B2688956BD959F933F8` | 18 |
| ADA | `0x3EE2200Efb3400fAb9eacFdC3CD4931b2BE1c940` | 18 |
| SOL | `0x5B6DeB658A359fbABC7eC1e67aB2916fF7aA9921` | 18 |
| AVAX | `0x97F6b66Fb81167EAc352007F1e319F54310b8F5C` | 18 |
| DOT | `0x7083609fCE4d1d8DC0C979AAb8c869A2F0fF493C` | 18 |
| BUSD | `0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56` | 18 |
| USDT | `0x55d398326f99059fF775485246999027B3197955` | 18 |
| DOGE | `0xc7F3a06Ddd22a5E10B72e00B2e8c9A35e3836F61` | 8 |

---

## License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

<div align="center">

**Built for [BNB Hack: AI Trading Agent Edition](https://www.bnbchain.org/)**

Track 1: Autonomous Trading Agents — $24,000 Prize Pool

Made with TypeScript, Ethers.js, and a lot of signal analysis.

</div>
