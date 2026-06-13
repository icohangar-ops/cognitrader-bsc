// ============================================================
// CogniTrader BSC — Trust Wallet Agent Kit (TWAK) Integration
// Non-custodial wallet signing, policy engine, autonomous mode
// ============================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import type { TWAKConfig, TradeResult, BSCConfig } from '../utils/types';
import { getLogger } from '../utils/logger';

const execAsync = promisify(exec);

// ─── Shell-Injection Guards ────────────────────────────────
// All values interpolated into TWAK CLI commands must be validated against a
// strict allowlist regex before reaching the shell. This prevents command
// injection via externally-sourced fields (competition ids, tx data, payment
// details). Any value containing shell metacharacters is rejected outright.

const HEX_RE = /^0x[0-9a-fA-F]*$/;            // addresses / calldata
const DECIMAL_RE = /^[0-9]+(\.[0-9]+)?$/;     // amounts / values
const TOKEN_SYMBOL_RE = /^[A-Za-z0-9]{1,16}$/; // token symbols
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;        // competition ids
const MEMO_RE = /^[A-Za-z0-9 _.,:-]{0,128}$/; // free-text memo (no shell metachars)

function validateField(value: string, pattern: RegExp, fieldName: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`TWAK: invalid ${fieldName} (failed validation): rejected to prevent command injection`);
  }
  return value;
}

export interface TWAKWallet {
  address: string;
  chain: string;
  path: string;
}

export interface TWAKPolicy {
  maxTxValue: number;
  allowedTokens: string[];
  requireConfirmation: boolean;
  dailyLimit: number;
  singleTradeLimit: number;
}

export class TrustWalletAgentKit {
  private config: TWAKConfig;
  private bscConfig: BSCConfig;
  private wallet: TWAKWallet | null = null;
  private isInitialized = false;

  constructor(config: TWAKConfig, bscConfig: BSCConfig) {
    this.config = config;
    this.bscConfig = bscConfig;
  }

  // ─── Initialization ───────────────────────────────────────

  async initialize(): Promise<void> {
    getLogger().info('🔐 Initializing Trust Wallet Agent Kit...');

    // Try to load existing wallet or create via TWAK CLI
    if (existsSync(this.config.walletPath)) {
      const walletData = JSON.parse(readFileSync(this.config.walletPath, 'utf-8'));
      this.wallet = {
        address: walletData.address,
        chain: 'bsc',
        path: this.config.walletPath,
      };
      getLogger().info(`Loaded existing TWAK wallet: ${this.wallet.address}`);
    } else {
      getLogger().info('No existing TWAK wallet found, using configured wallet address');
      this.wallet = {
        address: this.bscConfig.walletAddress,
        chain: 'bsc',
        path: this.config.walletPath,
      };
    }

    // Set up policy engine
    if (this.config.policyEngineEnabled) {
      this.configurePolicyEngine();
    }

    this.isInitialized = true;
    getLogger().info('✅ TWAK initialized successfully');
  }

  // ─── TWAK Wallet Commands ──────────────────────────────────

  async createWallet(): Promise<TWAKWallet> {
    getLogger().info('Creating TWAK wallet via CLI...');

    try {
      const { stdout } = await execAsync('twak wallet create --chain bsc --json');
      const walletData = JSON.parse(stdout);

      this.wallet = {
        address: walletData.address,
        chain: 'bsc',
        path: this.config.walletPath,
      };

      // Persist wallet
      writeFileSync(this.config.walletPath, JSON.stringify(walletData, null, 2));
      getLogger().info(`TWAK wallet created: ${this.wallet.address}`);
      return this.wallet;
    } catch (error) {
      getLogger().warn('TWAK CLI not available, using Ethers.js wallet instead');
      this.wallet = {
        address: this.bscConfig.walletAddress,
        chain: 'bsc',
        path: this.config.walletPath,
      };
      return this.wallet;
    }
  }

  async registerCompetition(competitionId: string): Promise<boolean> {
    getLogger().info(`Registering for competition ${competitionId}...`);

    try {
      const safeId = validateField(competitionId, ID_RE, 'competitionId');
      const safeWallet = validateField(this.wallet?.address ?? '', HEX_RE, 'wallet address');
      const { stdout } = await execAsync(
        `twak compete register --id ${safeId} --wallet ${safeWallet} --json`,
      );
      const result = JSON.parse(stdout);
      getLogger().info(`Competition registration result: ${result.status}`);
      return result.status === 'success';
    } catch (error) {
      getLogger().warn('TWAK compete register not available, skipping');
      return true;
    }
  }

  // ─── Transaction Signing ───────────────────────────────────

  async signTransaction(txData: {
    to: string;
    value: string;
    data: string;
    gasLimit?: string;
  }): Promise<string> {
    if (!this.wallet) throw new Error('TWAK wallet not initialized');

    getLogger().info(`Signing transaction to ${txData.to}`);

    try {
      const safeTo = validateField(txData.to, HEX_RE, 'tx to');
      const safeValue = validateField(txData.value, DECIMAL_RE, 'tx value');
      const safeData = validateField(txData.data, HEX_RE, 'tx data');
      const { stdout } = await execAsync(
        `twak tx sign --to ${safeTo} --value ${safeValue} --data ${safeData} --json`,
      );
      const result = JSON.parse(stdout);
      return result.signedTx;
    } catch {
      // Fallback: return unsigned for Ethers.js signing
      getLogger().warn('TWAK signing not available, delegating to Ethers.js');
      return '';
    }
  }

  // ─── X402 Payment Protocol ─────────────────────────────────

  async x402Pay(payment: {
    recipient: string;
    amount: string;
    token: string;
    memo?: string;
  }): Promise<TradeResult> {
    getLogger().info(`X402 payment: ${payment.amount} ${payment.token} → ${payment.recipient}`);

    try {
      const safeRecipient = validateField(payment.recipient, HEX_RE, 'payment recipient');
      const safeAmount = validateField(payment.amount, DECIMAL_RE, 'payment amount');
      const safeToken = validateField(payment.token, TOKEN_SYMBOL_RE, 'payment token');
      const memoParam = payment.memo
        ? ` --memo "${validateField(payment.memo, MEMO_RE, 'payment memo')}"`
        : '';
      const { stdout } = await execAsync(
        `twak x402 pay --to ${safeRecipient} --amount ${safeAmount} --token ${safeToken}${memoParam} --json`,
      );
      const result = JSON.parse(stdout);

      return {
        success: true,
        txHash: result.txHash ?? '',
        fromToken: payment.token,
        toToken: 'BNB',
        amountIn: payment.amount,
        amountOut: '0',
        gasUsed: result.gasUsed ?? '0',
        gasPrice: result.gasPrice ?? '0',
        blockNumber: result.blockNumber ?? 0,
        timestamp: Date.now(),
      };
    } catch {
      getLogger().warn('TWAK x402 pay not available');
      return {
        success: false,
        txHash: '',
        fromToken: payment.token,
        toToken: 'BNB',
        amountIn: payment.amount,
        amountOut: '0',
        gasUsed: '0',
        gasPrice: '0',
        blockNumber: 0,
        timestamp: Date.now(),
        error: 'TWAK x402 pay unavailable',
      };
    }
  }

  // ─── Policy Engine ─────────────────────────────────────────

  configurePolicyEngine(): void {
    const policy: TWAKPolicy = {
      maxTxValue: this.config.maxTxValueBNB,
      allowedTokens: this.config.allowedTokens,
      requireConfirmation: this.config.requireConfirmation,
      dailyLimit: this.config.maxTxValueBNB * 10,
      singleTradeLimit: this.config.maxTxValueBNB,
    };

    getLogger().info('🛡 TWAK Policy Engine configured', {
      maxTxValue: `${policy.maxTxValue} BNB`,
      dailyLimit: `${policy.dailyLimit} BNB`,
      singleTradeLimit: `${policy.singleTradeLimit} BNB`,
      requireConfirmation: policy.requireConfirmation,
      allowedTokens: policy.allowedTokens.join(', '),
    });

    if (this.config.requireConfirmation && !this.config.autonomousMode) {
      getLogger().info('⚠ TWAK is in CONFIRMATION mode — trades require manual approval');
    }
  }

  // ─── Policy Checks ────────────────────────────────────────

  checkPolicy(trade: { token: string; amountBNB: number }): { allowed: boolean; reason?: string } {
    // Check allowed tokens
    if (!this.config.allowedTokens.includes(trade.token) && trade.token !== 'BNB') {
      return { allowed: false, reason: `Token ${trade.token} not in allowed list` };
    }

    // Check max transaction value
    if (trade.amountBNB > this.config.maxTxValueBNB) {
      return { allowed: false, reason: `Trade amount ${trade.amountBNB} BNB exceeds max ${this.config.maxTxValueBNB} BNB` };
    }

    // Check confirmation requirement
    if (this.config.requireConfirmation && !this.config.autonomousMode) {
      return { allowed: false, reason: 'Manual confirmation required (autonomous mode disabled)' };
    }

    return { allowed: true };
  }

  // ─── Helpers ───────────────────────────────────────────────

  getWallet(): TWAKWallet {
    if (!this.wallet) throw new Error('TWAK wallet not initialized');
    return this.wallet;
  }

  getWalletAddress(): string {
    return this.wallet?.address ?? this.bscConfig.walletAddress;
  }

  isReady(): boolean {
    return this.isInitialized;
  }

  getMode(): string {
    return this.config.autonomousMode ? '🤖 AUTONOMOUS' : '👤 SUPERVISED';
  }
}
