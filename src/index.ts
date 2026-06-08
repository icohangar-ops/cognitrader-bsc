// ============================================================
// CogniTrader BSC — Main Entry Point
// Starts the autonomous trading agent loop
// ============================================================

import { loadConfig, validateConfig } from './utils/config';
import { initLogger } from './utils/logger';
import { CogniTrader } from './agent/CogniTrader';

async function main(): Promise<void> {
  // ─── Banner ───────────────────────────────────────────────
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   ██████╗ ██████╗ ███████╗   ██████╗  ██████╗ ███████╗      ║
║  ██╔════╝ ██╔══██╗██╔════╝   ██╔══██╗██╔═══██╗██╔════╝     ║
║  ██║  ███╗██████╔╝███████╗   ██║  ██║██║   ██║███████╗     ║
║  ██║   ██║██╔══██╗╚════██║   ██║  ██║██║   ██║╚════██║     ║
║  ╚██████╔╝██║  ██║███████║   ██████╔╝╚██████╔╝███████║     ║
║   ╚═════╝ ╚═╝  ╚═╝╚══════╝   ╚═════╝  ╚═════╝ ╚══════╝     ║
║                                                              ║
║   Multi-Signal AI Trading Agent on BNB Chain                ║
║   BNB Hack 2026 — Track 1: Autonomous Trading Agents        ║
║                                                              ║
║   Built with:                                                ║
║   • CoinMarketCap API — Market Data & Sentiment             ║
║   • Trust Wallet Agent Kit — Non-Custodial Signing          ║
║   • BNB AI Agent SDK — Agent Orchestration                  ║
║   • Ethers.js v6 — BSC On-Chain Execution                   ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);

  // ─── Load & Validate Config ─────────────────────────────────
  try {
    const config = loadConfig();
    validateConfig(config);

    // Initialize logger with configured level
    initLogger(config.agent.logLevel);
    const logger = initLogger(config.agent.logLevel);

    logger.info('Configuration loaded and validated successfully');

    // ─── Create Agent ──────────────────────────────────────────
    const agent = new CogniTrader(config);

    // ─── Initialize ────────────────────────────────────────────
    await agent.initialize();

    // ─── Graceful Shutdown ────────────────────────────────────
    const shutdown = (signal: string): void => {
      logger.info(`\n📢 Received ${signal} — shutting down gracefully...`);
      agent.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection:', reason);
      shutdown('unhandledRejection');
    });

    // ─── Start Agent Loop ─────────────────────────────────────
    agent.start();

    logger.info('\n🤖 CogniTrader BSC is now running. Press Ctrl+C to stop.\n');

  } catch (error) {
    console.error('❌ Failed to start CogniTrader BSC:');
    console.error(error instanceof Error ? error.message : String(error));
    console.error('\nPlease check your .env configuration file.');
    console.error('See README.md for setup instructions.');
    process.exit(1);
  }
}

// ─── Run ─────────────────────────────────────────────────────

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
