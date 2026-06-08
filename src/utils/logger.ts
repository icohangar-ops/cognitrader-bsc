// ============================================================
// CogniTrader BSC — Structured Logging Utility
// ============================================================

import winston from 'winston';
import type { AgentMetrics } from './types';

const { combine, timestamp, printf, colorize, errors } = winston.format;

const LOG_FORMAT = printf(({ level, message, timestamp: ts, ...meta }) => {
  const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  return `[${ts}] ${level.toUpperCase().padEnd(5)} | ${message}${metaStr}`;
});

let logger: winston.Logger;

export function initLogger(level: string = 'info'): winston.Logger {
  logger = winston.createLogger({
    level,
    format: combine(
      errors({ stack: true }),
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      LOG_FORMAT,
    ),
    transports: [
      new winston.transports.Console({ format: combine(colorize(), LOG_FORMAT) }),
      new winston.transports.File({
        filename: 'logs/cognitrader.log',
        maxsize: 10 * 1024 * 1024, // 10 MB
        maxFiles: 5,
      }),
      new winston.transports.File({
        filename: 'logs/cognitrader-error.log',
        level: 'error',
        maxsize: 10 * 1024 * 1024,
        maxFiles: 3,
      }),
    ],
  });

  return logger;
}

export function getLogger(): winston.Logger {
  if (!logger) {
    return initLogger('info');
  }
  return logger;
}

// ─── Convenience helpers ─────────────────────────────────────

export function logSignal(token: string, score: number, direction: string, strength: string): void {
  getLogger().info(`Signal generated for ${token}`, {
    token,
    score,
    direction,
    strength,
    emoji: score >= 80 ? '🟢' : score >= 65 ? '🟡' : '🔴',
  });
}

export function logTrade(decision: { token: string; amountIn: string; direction: string; reasoning: string }): void {
  getLogger().info(`Trade decision: ${decision.direction} ${decision.amountIn} BNB → ${decision.token}`, {
    token: decision.token,
    amountIn: decision.amountIn,
    direction: decision.direction,
    reasoning: decision.reasoning,
  });
}

export function logRiskWarning(warning: string): void {
  getLogger().warn(`⚠ RISK: ${warning}`);
}

export function logRiskBlocked(reason: string): void {
  getLogger().error(`🚫 RISK BLOCKED: ${reason}`);
}

export function logMetrics(metrics: AgentMetrics): void {
  const winRate = metrics.totalTrades > 0
    ? ((metrics.winningTrades / metrics.totalTrades) * 100).toFixed(1)
    : 'N/A';

  getLogger().info('📊 Agent Metrics Update', {
    status: metrics.status,
    totalTrades: metrics.totalTrades,
    winRate: `${winRate}%`,
    totalPnL: metrics.totalPnL.toFixed(6),
    openPositions: metrics.portfolio.positions.length,
    dailyPnL: metrics.portfolio.dailyPnL.toFixed(6),
    maxDrawdown: metrics.portfolio.maxDrawdown.toFixed(4),
  });
}

export function logError(context: string, error: unknown): void {
  getLogger().error(`${context}: ${error instanceof Error ? error.message : String(error)}`, {
    stack: error instanceof Error ? error.stack : undefined,
  });
}
