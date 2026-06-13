// ============================================================
// CogniTrader BSC — BSC Blockchain Interaction
// Ethers.js v6 for on-chain operations, PancakeSwap swaps
// ============================================================

import { ethers, type JsonRpcProvider, type Wallet } from 'ethers';
import type { BSCConfig, TradeResult, TokenPair } from '../utils/types';
import { getLogger } from '../utils/logger';
import { ioRetry } from '../lib/resilience';

// PancakeSwap V2 Router ABI (minimal — swapExactTokensForTokens)
const PANCAKE_ROUTER_ABI = [
  // Get amount of tokens out for a swap
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  // Swap exact tokens for tokens
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
];

// ERC-20 ABI (minimal)
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// ─── Common BSC Token Addresses ───────────────────────────────

const KNOWN_TOKENS: Record<string, TokenPair> = {
  CAKE: { base: 'CAKE', quote: 'BNB', address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18, symbol: 'CAKE' },
  BNB:  { base: 'BNB',  quote: 'BNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18, symbol: 'WBNB' },
  BUSD: { base: 'BUSD', quote: 'BNB', address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18, symbol: 'BUSD' },
  ETH:  { base: 'ETH',  quote: 'BNB', address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', decimals: 18, symbol: 'ETH' },
  ADA:  { base: 'ADA',  quote: 'BNB', address: '0x3EE2200Efb3400fAb9eacFdC3CD4931b2BE1c940', decimals: 18, symbol: 'ADA' },
  SOL:  { base: 'SOL',  quote: 'BNB', address: '0x5B6DeB658A359fbABC7eC1e67aB2916fF7aA9921', decimals: 18, symbol: 'SOL' },
  AVAX: { base: 'AVAX', quote: 'BNB', address: '0x97F6b66Fb81167EAc352007F1e319F54310b8F5C', decimals: 18, symbol: 'AVAX' },
  DOT:  { base: 'DOT',  quote: 'BNB', address: '0x7083609fCE4d1d8DC0C979AAb8c869A2F0fF493C', decimals: 18, symbol: 'DOT' },
  DOGE: { base: 'DOGE', quote: 'BNB', address: '0xc7F3a06Ddd22a5E10B72e00B2e8c9A35e3836F61', decimals: 8, symbol: 'DOGE' },
  USDT: { base: 'USDT', quote: 'BNB', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, symbol: 'USDT' },
};

export class BSCClient {
  private config: BSCConfig;
  private provider: JsonRpcProvider;
  private wallet: Wallet;
  private ready = false;

  // ─── RPC endpoint pool (primary + BSC_RPC_FALLBACK_URLS) ────
  // Distinct provider/wallet/router triples, one per endpoint. The retry loop
  // rotates through these on failure so a single unhealthy node does not stall
  // the agent.
  private readonly rpcUrls: string[];
  private readonly providers: JsonRpcProvider[];
  private readonly wallets: Wallet[];
  private readonly routers: ethers.Contract[];

  constructor(config: BSCConfig) {
    this.config = config;

    this.rpcUrls = [config.rpcUrl, ...(config.rpcFallbackUrls ?? [])];
    this.providers = this.rpcUrls.map(
      (url) => new ethers.JsonRpcProvider(url, { chainId: config.chainId, name: 'bsc' }),
    );
    this.wallets = this.providers.map((p) => new ethers.Wallet(config.privateKey, p));
    this.routers = this.wallets.map(
      (w) => new ethers.Contract(config.pancakeSwapRouter, PANCAKE_ROUTER_ABI, w),
    );

    // Primary endpoint stays the default for any direct accessor (getProvider, etc.).
    this.provider = this.providers[0];
    this.wallet = this.wallets[0];
  }

  // ─── Resilient RPC call w/ failover ─────────────────────────
  // Retries (3 attempts, 1s/2s/4s backoff) and rotates to the next RPC
  // endpoint on each retry. `fn` receives the provider/wallet/router triple
  // bound to the endpoint selected for that attempt.
  private async rpcCall<T>(
    label: string,
    fn: (ctx: { provider: JsonRpcProvider; wallet: Wallet; router: ethers.Contract }) => Promise<T>,
  ): Promise<T> {
    const count = this.providers.length;
    return ioRetry<T>(
      (attempt) => {
        const idx = (attempt - 1) % count;
        return fn({
          provider: this.providers[idx],
          wallet: this.wallets[idx],
          router: this.routers[idx],
        });
      },
      {
        label,
        onRetry: ({ attempt, delayMs, error }) => {
          const nextIdx = attempt % count;
          const msg = error instanceof Error ? error.message : String(error);
          getLogger().warn(
            `BSC RPC ${label} retry ${attempt} after ${delayMs}ms (rotating to ${this.rpcUrls[nextIdx]}): ${msg}`,
          );
        },
      },
    );
  }

  // ─── Initialization ───────────────────────────────────────

  async initialize(): Promise<void> {
    getLogger().info('⛓ Connecting to BSC network...');

    try {
      const { network, balance } = await this.rpcCall('initialize', async ({ provider, wallet }) => ({
        network: await provider.getNetwork(),
        balance: await provider.getBalance(wallet.address),
      }));

      getLogger().info(`✅ BSC connected — Chain: ${network.name} (${network.chainId})`);
      getLogger().info(`💰 Wallet: ${this.wallet.address}`);
      getLogger().info(`💰 Balance: ${ethers.formatEther(balance)} BNB`);

      this.ready = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      getLogger().error(`Failed to connect to BSC: ${msg}`);
      throw new Error(`BSC connection failed: ${msg}`);
    }
  }

  // ─── Balance Queries ──────────────────────────────────────

  async getBNBBalance(): Promise<number> {
    const balance = await this.rpcCall('getBNBBalance', ({ provider, wallet }) =>
      provider.getBalance(wallet.address),
    );
    return parseFloat(ethers.formatEther(balance));
  }

  async getTokenBalance(tokenAddress: string): Promise<number> {
    return this.rpcCall('getTokenBalance', async ({ provider, wallet }) => {
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      const balance = await token.balanceOf(wallet.address);
      const decimals = await token.decimals();
      return parseFloat(ethers.formatUnits(balance, decimals));
    });
  }

  // ─── Price Queries ─────────────────────────────────────────

  async getPriceBNB(tokenSymbol: string): Promise<number> {
    const token = KNOWN_TOKENS[tokenSymbol.toUpperCase()];
    if (!token) {
      getLogger().warn(`Unknown token: ${tokenSymbol}, returning 0`);
      return 0;
    }

    try {
      const wbnb = this.config.wbnbAddress;
      const amountIn = ethers.parseEther('1');
      const path = [wbnb, token.address];
      const amounts = await this.rpcCall(`getPriceBNB:${tokenSymbol}`, ({ router }) =>
        router.getAmountsOut(amountIn, path),
      );
      const amountOut = amounts[1];
      const decimals = token.decimals;
      return parseFloat(ethers.formatUnits(amountOut, decimals));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      getLogger().error(`Price query failed for ${tokenSymbol}: ${msg}`);
      return 0;
    }
  }

  // ─── Swap Execution ───────────────────────────────────────

  async swapBNBForToken(
    tokenSymbol: string,
    amountInBNB: number,
    slippageBps: number,
    dryRun: boolean = false,
  ): Promise<TradeResult> {
    const token = KNOWN_TOKENS[tokenSymbol.toUpperCase()];
    if (!token) {
      return this.errorResult(tokenSymbol, `Unknown token: ${tokenSymbol}`);
    }

    getLogger().info(`🔄 Swapping ${amountInBNB} BNB → ${tokenSymbol} (slippage: ${slippageBps}bps)`);

    if (dryRun) {
      getLogger().info(`[DRY RUN] Would swap ${amountInBNB} BNB → ${tokenSymbol}`);
      return this.dryRunResult('BNB', tokenSymbol, amountInBNB);
    }

    try {
      const amountIn = ethers.parseEther(amountInBNB.toString());
      const wbnb = this.config.wbnbAddress;
      const path = [wbnb, token.address];

      // Get expected output (idempotent read — safe to retry / fail over)
      const amountsOut = await this.rpcCall('swapBNBForToken:getAmountsOut', ({ router }) =>
        router.getAmountsOut(amountIn, path),
      );
      const expectedOut = amountsOut[amountsOut.length - 1];
      const minAmountOut = expectedOut * BigInt(10000 - slippageBps) / 10000n;

      // Execute swap. Only the broadcast is retried/failed-over: it returns
      // before the tx is mined, and a retry only happens when the node rejects
      // the broadcast (no tx hash yet), so there is no double-submit risk.
      const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min deadline
      const tx = await this.rpcCall('swapBNBForToken:broadcast', ({ router, wallet }) =>
        router.swapExactETHForTokens(minAmountOut, path, wallet.address, deadline, {
          value: amountIn,
          gasLimit: 300_000n,
        }),
      );

      const receipt = await tx.wait();
      if (!receipt) {
        return this.errorResult(tokenSymbol, 'Transaction receipt not available');
      }

      const actualGasUsed = receipt.gasUsed.toString();
      const gasPrice = receipt.gasPrice?.toString() ?? '0';

      getLogger().info(`✅ Swap executed — TX: ${receipt.hash}`);
      getLogger().info(`   Gas used: ${actualGasUsed}, Block: ${receipt.blockNumber}`);

      return {
        success: true,
        txHash: receipt.hash,
        fromToken: 'BNB',
        toToken: tokenSymbol,
        amountIn: amountInBNB.toString(),
        amountOut: ethers.formatUnits(expectedOut, token.decimals),
        gasUsed: actualGasUsed,
        gasPrice,
        blockNumber: receipt.blockNumber,
        timestamp: Date.now(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      getLogger().error(`Swap failed: ${msg}`);
      return this.errorResult(tokenSymbol, msg);
    }
  }

  async swapTokenForBNB(
    tokenSymbol: string,
    amountTokens: number,
    slippageBps: number,
    dryRun: boolean = false,
  ): Promise<TradeResult> {
    const token = KNOWN_TOKENS[tokenSymbol.toUpperCase()];
    if (!token) {
      return this.errorResult(tokenSymbol, `Unknown token: ${tokenSymbol}`);
    }

    getLogger().info(`🔄 Swapping ${amountTokens} ${tokenSymbol} → BNB (slippage: ${slippageBps}bps)`);

    if (dryRun) {
      getLogger().info(`[DRY RUN] Would swap ${amountTokens} ${tokenSymbol} → BNB`);
      return this.dryRunResult(tokenSymbol, 'BNB', amountTokens);
    }

    try {
      const decimals = token.decimals;
      const amountIn = ethers.parseUnits(amountTokens.toString(), decimals);
      const wbnb = this.config.wbnbAddress;
      const path = [token.address, wbnb];

      // Approve router (broadcast retried/failed-over before tx hash exists)
      getLogger().debug(`Approving PancakeSwap router for ${tokenSymbol}...`);
      const approveTx = await this.rpcCall('swapTokenForBNB:approve', ({ wallet }) => {
        const tokenContract = new ethers.Contract(token.address, ERC20_ABI, wallet);
        return tokenContract.approve(this.config.pancakeSwapRouter, amountIn);
      });
      await approveTx.wait();

      // Get expected output (idempotent read — safe to retry / fail over)
      const amountsOut = await this.rpcCall('swapTokenForBNB:getAmountsOut', ({ router }) =>
        router.getAmountsOut(amountIn, path),
      );
      const expectedOut = amountsOut[amountsOut.length - 1];
      const minAmountOut = expectedOut * BigInt(10000 - slippageBps) / 10000n;

      // Execute swap (only the broadcast is retried — see swapBNBForToken note)
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const tx = await this.rpcCall('swapTokenForBNB:broadcast', ({ router, wallet }) =>
        router.swapExactTokensForETH(amountIn, minAmountOut, path, wallet.address, deadline, {
          gasLimit: 300_000n,
        }),
      );

      const receipt = await tx.wait();
      if (!receipt) {
        return this.errorResult(tokenSymbol, 'Transaction receipt not available');
      }

      getLogger().info(`✅ Swap executed — TX: ${receipt.hash}`);

      return {
        success: true,
        txHash: receipt.hash,
        fromToken: tokenSymbol,
        toToken: 'BNB',
        amountIn: amountTokens.toString(),
        amountOut: ethers.formatEther(expectedOut),
        gasUsed: receipt.gasUsed.toString(),
        gasPrice: receipt.gasPrice?.toString() ?? '0',
        blockNumber: receipt.blockNumber,
        timestamp: Date.now(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      getLogger().error(`Swap back failed: ${msg}`);
      return this.errorResult(tokenSymbol, msg);
    }
  }

  // ─── Gas Price Estimation ──────────────────────────────────

  async estimateGasPrice(): Promise<number> {
    const feeData = await this.rpcCall('estimateGasPrice', ({ provider }) => provider.getFeeData());
    const gasPrice = feeData.gasPrice;
    return gasPrice ? parseFloat(ethers.formatUnits(gasPrice, 'gwei')) : 3; // default 3 gwei on BSC
  }

  // ─── Helpers ───────────────────────────────────────────────

  getTokenInfo(symbol: string): TokenPair | undefined {
    return KNOWN_TOKENS[symbol.toUpperCase()];
  }

  getAllKnownTokens(): Record<string, TokenPair> {
    return KNOWN_TOKENS;
  }

  getWalletAddress(): string {
    return this.wallet.address;
  }

  getProvider(): JsonRpcProvider {
    return this.provider;
  }

  isReady(): boolean {
    return this.ready;
  }

  private errorResult(token: string, error: string): TradeResult {
    return {
      success: false,
      txHash: '',
      fromToken: 'BNB',
      toToken: token,
      amountIn: '0',
      amountOut: '0',
      gasUsed: '0',
      gasPrice: '0',
      blockNumber: 0,
      timestamp: Date.now(),
      error,
    };
  }

  private dryRunResult(from: string, to: string, amount: number): TradeResult {
    return {
      success: true,
      txHash: `dry-run-${Date.now()}`,
      fromToken: from,
      toToken: to,
      amountIn: amount.toString(),
      amountOut: '0',
      gasUsed: '0',
      gasPrice: '0',
      blockNumber: 0,
      timestamp: Date.now(),
    };
  }
}
