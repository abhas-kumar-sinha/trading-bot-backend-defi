import axios from 'axios';
import logger from '../utils/logger';

type QuoteSelection = "automatic" | "manual";

interface QuoteParams {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  taker: string;
  slippage?: string;
}

interface QuoteResult {
  provider: '1inch' | 'LiFi';
  quote: any;
  buyAmount: string;
  sellAmount: string;
  estimatedGas?: string;
  allowanceTarget?: string;
  gasPrice?: string;
  netValue?: string;
}

interface AggregatedQuoteResult {
  bestQuote: QuoteResult;
  allQuotes: QuoteResult[];
  savings?: string;
  savingsType?: 'buyAmount' | 'netValue';
}

interface ApprovalTransaction {
  to: string;
  data: string;
  value: string;
  gasLimit?: string;
}

class QuoteAggregator {
  private ONEINCH_API_KEY: string;
  private CHAIN_ID = 56;
  private ONEINCH_BASE_URL = `https://api.1inch.dev/swap/v6.1/${this.CHAIN_ID}`;
  private LIFI_BASE_URL = `https://li.quest/v1`;

  // BSC native token representations
  private readonly WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
  // 1inch uses this standard address for native token on ALL chains
  private readonly NATIVE_TOKEN_ONEINCH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
  // LiFi uses null/undefined for native token
  private readonly NATIVE_TOKEN_LIFI = null;
  // 1inch router address on BSC
  private readonly ONEINCH_ROUTER_BSC = '0x111111125421ca6dc452d289314280a0f8842a65';

  constructor(oneInchApiKey: string) {
    this.ONEINCH_API_KEY = oneInchApiKey;
  }

  /**
   * Normalize token address to 1inch format
   * Returns the standard native token address if it's BNB
   */
  private normalize1inchToken(token: string): string {
    if (
      token === this.WBNB_ADDRESS ||
      token === this.NATIVE_TOKEN_ONEINCH ||
      token?.toLowerCase() === '0x0000000000000000000000000000000000000000'
    ) {
      return this.NATIVE_TOKEN_ONEINCH;
    }
    return token;
  }

  /**
   * Normalize token address to LiFi format
   * For native token, use null; otherwise use the token address
   */
  private normalizeLiFiToken(token: string): string | null {
    if (
      token === this.WBNB_ADDRESS ||
      token === this.NATIVE_TOKEN_ONEINCH ||
      token?.toLowerCase() === '0x0000000000000000000000000000000000000000'
    ) {
      return this.NATIVE_TOKEN_LIFI;
    }
    return token;
  }

  /**
   * Checks if token is native (BNB, ETH, etc.)
   */
  private isNativeToken(address: string): boolean {
    const normalized = address.toLowerCase();
    return (
      normalized === this.NATIVE_TOKEN_ONEINCH.toLowerCase() ||
      normalized === '0x0000000000000000000000000000000000000000' ||
      normalized === this.WBNB_ADDRESS.toLowerCase()
    );
  }

  /**
   * Checks token allowance for 1inch router
   * Returns the current allowance amount
   */
  async check1inchAllowance(
    tokenAddress: string,
    ownerAddress: string
  ): Promise<string> {
    try {
      // Skip allowance check for native tokens
      if (this.isNativeToken(tokenAddress)) {
        return '0'; // Native tokens don't need approval
      }

      const allowanceUrl = `${this.ONEINCH_BASE_URL}/approve/allowance`;
      const params = {
        tokenAddress,
        walletAddress: ownerAddress,
      };

      logger.info(`Checking 1inch allowance for token ${tokenAddress}...`);
      
      const allowanceResponse = await axios.get(allowanceUrl, {
        params,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.ONEINCH_API_KEY}`,
        },
        timeout: 10000,
      });

      const currentAllowance = allowanceResponse.data.allowance || '0';
      logger.info(`Current allowance: ${currentAllowance}`);
      
      return currentAllowance;
    } catch (error: any) {
      logger.error(`1inch allowance check failed: ${error.response?.data?.description || error.message}`);
      return '0';
    }
  }

  /**
   * Gets approval transaction data for 1inch router
   * Returns transaction data that needs to be executed to approve tokens
   */
  async get1inchApprovalTx(
    tokenAddress: string,
    amount?: string
  ): Promise<ApprovalTransaction | null> {
    try {
      // Skip approval for native tokens
      if (this.isNativeToken(tokenAddress)) {
        logger.info(`Native token detected, no approval needed`);
        return null;
      }

      const approveUrl = `${this.ONEINCH_BASE_URL}/approve/transaction`;
      const params: any = {
        tokenAddress,
      };

      // If amount is provided, approve specific amount; otherwise approve unlimited
      if (amount) {
        params.amount = amount;
      }

      logger.info(`Getting 1inch approval transaction for token ${tokenAddress}...`);
      
      const approveResponse = await axios.get(approveUrl, {
        params,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.ONEINCH_API_KEY}`,
        },
        timeout: 10000,
      });

      const approveTx = approveResponse.data;

      if (!approveTx || !approveTx.data || !approveTx.to) {
        logger.warn(`1inch: Invalid approval transaction response`);
        return null;
      }

      logger.info(`Approval transaction obtained:`, {
        to: approveTx.to,
        gasLimit: approveTx.gasLimit || approveTx.gas || '100000',
      });

      return {
        to: approveTx.to,
        data: approveTx.data,
        value: approveTx.value || '0',
        gasLimit: approveTx.gasLimit || approveTx.gas,
      };
    } catch (error: any) {
      logger.error(`1inch approval tx failed: ${error.response?.data?.description || error.message}`);
      return null;
    }
  }

  /**
   * Checks if token has sufficient allowance for the swap
   * Returns true if allowance is sufficient, false if approval is needed
   */
  async hasEnough1inchAllowance(
    tokenAddress: string,
    ownerAddress: string,
    requiredAmount: string
  ): Promise<boolean> {
    try {
      // Native tokens don't need approval
      if (this.isNativeToken(tokenAddress)) {
        return true;
      }

      const currentAllowance = await this.check1inchAllowance(tokenAddress, ownerAddress);
      
      const hasEnough = BigInt(currentAllowance) >= BigInt(requiredAmount);
      
      if (hasEnough) {
        logger.info(`✅ Sufficient allowance: ${currentAllowance} >= ${requiredAmount}`);
      } else {
        logger.warn(`⚠️  Insufficient allowance: ${currentAllowance} < ${requiredAmount}`);
        logger.warn(`   Approval required for ${tokenAddress}`);
      }
      
      return hasEnough;
    } catch (error: any) {
      logger.error(`Error checking allowance: ${error.message}`);
      return false;
    }
  }

  /**
   * Fetches quote from 1inch API
   * 1inch uses 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE for native tokens
   */
  private async get1inchQuote(params: QuoteParams): Promise<QuoteResult | null> {
    try {
      const src = this.normalize1inchToken(params.sellToken);
      const dst = this.normalize1inchToken(params.buyToken);

      // Check allowance before getting quote (only for token sells, not native BNB)
      if (!this.isNativeToken(params.sellToken)) {
        logger.info(`Checking if approval is needed for token swap...`);
        
        const hasAllowance = await this.hasEnough1inchAllowance(
          params.sellToken,
          params.taker,
          params.sellAmount
        );

        if (!hasAllowance) {
          logger.error(`❌ Insufficient token allowance for 1inch router`);
          logger.error(`   Token: ${params.sellToken}`);
          logger.error(`   Amount needed: ${params.sellAmount}`);
          logger.error(`   Please approve tokens first using get1inchApprovalTx()`);
          return null;
        }
        
        logger.info(`✅ Token approval verified`);
      }

      const swapParams = {
        src,
        dst,
        amount: params.sellAmount,
        from: params.taker,
        origin: params.taker,
        slippage: params.slippage || '1',
      };

      const swapUrl = `${this.ONEINCH_BASE_URL}/swap?${new URLSearchParams(swapParams).toString()}`;
      
      logger.info(`Fetching 1inch quote...`);
      const swapResponse = await axios.get(swapUrl, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.ONEINCH_API_KEY}`,
        },
        timeout: 15000,
      });

      const swapData = swapResponse.data;

      if (!swapData || !swapData.dstAmount) {
        logger.warn(`1inch: Invalid quote response`);
        return null;
      }

      const estimatedGas = swapData.tx?.gas || '500000';
      const gasPrice = swapData.tx?.gasPrice;

      if (gasPrice) {
        logger.info(`1inch gas price: ${Number(gasPrice) / 1e9} Gwei`);
      }

      return {
        provider: '1inch',
        quote: swapData,
        buyAmount: swapData.dstAmount,
        sellAmount: params.sellAmount,
        estimatedGas,
        gasPrice,
        allowanceTarget: swapData.tx?.to,
      };
    } catch (error: any) {
      logger.error(`1inch quote failed: ${error.response?.data?.description || error.message}`);
      return null;
    }
  }

  /**
   * Fetches quote from LiFi API
   * LiFi uses null for native token, not an address
   */
  private async getLiFiQuote(params: QuoteParams): Promise<QuoteResult | null> {
    try {
      logger.info(`Fetching LiFi quote...`);

      // For same-chain swaps, both fromChain and toChain are the same
      const fromToken = this.normalizeLiFiToken(params.sellToken);
      const toToken = this.normalizeLiFiToken(params.buyToken);

      const quoteParams: any = {
        fromChain: this.CHAIN_ID.toString(),
        toChain: this.CHAIN_ID.toString(),
        fromToken: fromToken === null ? undefined : fromToken,
        toToken: toToken === null ? undefined : toToken,
        fromAmount: params.sellAmount,
        fromAddress: params.taker,
        slippage: (Number(params.slippage || '1') / 100).toString(), // LiFi uses decimal format (0.01 for 1%)
      };

      // Remove undefined keys for cleaner API call
      Object.keys(quoteParams).forEach(
        (key) => quoteParams[key] === undefined && delete quoteParams[key]
      );

      const quoteUrl = `${this.LIFI_BASE_URL}/quote?${new URLSearchParams(quoteParams).toString()}`;
      const quoteRes = await axios.get(quoteUrl, { timeout: 15000 });
      const quote = quoteRes.data;

      if (!quote || !quote.estimate || !quote.estimate.toAmount) {
        logger.warn(`LiFi: No quote available`);
        return null;
      }

      // LiFi returns gas estimates in the gasCosts array
      const gasCosts = quote.estimate.gasCosts || [];
      const totalGasEstimate = gasCosts.reduce((sum: number, cost: any) => {
        return sum + Number(cost.estimate || 0);
      }, 0);

      const estimatedGas = totalGasEstimate > 0 ? totalGasEstimate.toString() : '500000';
      const gasPrice = gasCosts[0]?.price;

      if (gasPrice) {
        logger.info(`LiFi gas price: ${Number(gasPrice) / 1e9} Gwei`);
      }
      logger.info(`LiFi using tool: ${quote.tool}`);

      return {
        provider: 'LiFi',
        quote: quote,
        buyAmount: quote.estimate.toAmount,
        sellAmount: params.sellAmount,
        estimatedGas,
        gasPrice,
        allowanceTarget: quote.estimate.approvalAddress,
      };
    } catch (error: any) {
      logger.error(`LiFi quote failed: ${error.response?.data?.message || error.message}`);
      return null;
    }
  }

  /**
   * Calculate net value after gas costs
   */
  private calculateNetValue(quote: QuoteResult, isBuyingNative: boolean): string {
    const buyAmount = BigInt(quote.buyAmount);
    
    if (isBuyingNative && quote.estimatedGas && quote.gasPrice) {
      const gasLimit = BigInt(quote.estimatedGas);
      const gasPrice = BigInt(quote.gasPrice);
      const gasCost = gasLimit * gasPrice;
      const netValue = buyAmount - gasCost;
      return netValue > 0n ? netValue.toString() : '0';
    }
    
    return buyAmount.toString();
  }

  /**
   * Compare quotes
   */
  private compareQuotes(quote1: QuoteResult, quote2: QuoteResult): number {
    const netValue1 = BigInt(quote1.netValue || quote1.buyAmount);
    const netValue2 = BigInt(quote2.netValue || quote2.buyAmount);

    if (netValue1 > netValue2) return 1;
    if (netValue1 < netValue2) return -1;
    return 0;
  }

  /**
   * Main function to get best quote from all providers
   */
  async getBestQuote(params: QuoteParams): Promise<AggregatedQuoteResult | null> {
    logger.info(`🔍 Fetching quotes from 2 aggregators...`);
    logger.info(`   Providers: 1inch, LiFi`);

    const isBuyingNative = 
      params.buyToken === this.WBNB_ADDRESS ||
      params.buyToken === this.NATIVE_TOKEN_ONEINCH ||
      params.buyToken?.toLowerCase() === '0x0000000000000000000000000000000000000000';

    // Fetch quotes in parallel from all providers
    const [
      oneInchQuote,
      lifiQuote,
    ] = await Promise.all([
      this.get1inchQuote(params),
      this.getLiFiQuote(params),
    ]);

    const validQuotes: QuoteResult[] = [];
    
    for (const quote of [oneInchQuote, lifiQuote]) {
      if (quote) {
        quote.netValue = this.calculateNetValue(quote, isBuyingNative);
        validQuotes.push(quote);
      }
    }

    if (validQuotes.length === 0) {
      logger.error('❌ No valid quotes from any provider');
      return null;
    }

    // Sort by net value (descending)
    validQuotes.sort((a, b) => this.compareQuotes(b, a));

    const bestQuote = validQuotes[0];
    const worstQuote = validQuotes[validQuotes.length - 1];

    // Calculate savings
    let savings: string | undefined;
    let savingsType: 'buyAmount' | 'netValue' = 'netValue';
    
    if (validQuotes.length > 1) {
      const bestNetValue = BigInt(bestQuote.netValue || bestQuote.buyAmount);
      const worstNetValue = BigInt(worstQuote.netValue || worstQuote.buyAmount);
      
      if (worstNetValue > 0n) {
        const diff = bestNetValue - worstNetValue;
        const percentage = (Number(diff) * 100) / Number(worstNetValue);
        savings = percentage.toFixed(4);
      }
    }

    logger.info(`\n✅ Best quote from ${bestQuote.provider}`);
    logger.info(`   Buy amount: ${bestQuote.buyAmount}`);
    logger.info(`   Net value (after gas): ${bestQuote.netValue}`);
    logger.info(`   Estimated gas: ${bestQuote.estimatedGas}`);
    
    if (savings) {
      logger.info(`   💰 Savings: ${savings}% better than ${worstQuote.provider}`);
    }

    // Detailed comparison
    logger.info(`\n📊 Detailed Comparison (${validQuotes.length} quotes):`);
    validQuotes.forEach((q, idx) => {
      logger.info(`   ${idx + 1}. ${q.provider}:`);
      logger.info(`      • Buy amount: ${q.buyAmount}`);
      
      if (q.gasPrice) {
        const gasCost = BigInt(q.estimatedGas || '500000') * BigInt(q.gasPrice);
        const gasCostBNB = Number(gasCost) / 1e18;
        const gasPriceGwei = Number(q.gasPrice) / 1e9;
        
        logger.info(`      • Gas price: ${gasPriceGwei.toFixed(2)} Gwei`);
        logger.info(`      • Gas units: ${q.estimatedGas} (${gasCostBNB.toFixed(6)} BNB)`);
      }
      
      logger.info(`      • Net value: ${q.netValue}`);
    });

    return {
      bestQuote,
      allQuotes: validQuotes,
      savings,
      savingsType,
    };
  }

  /**
   * Main function to get best quote from all providers
   */
  async getAllBestQuote(params: QuoteParams): Promise<QuoteResult[] | null> {
    logger.info('🔍 Fetching quotes from 2 aggregators...');
    logger.info('   Providers: 1inch, LiFi');
    
    const isBuyingNative = 
      params.buyToken === this.WBNB_ADDRESS ||
      params.buyToken === this.NATIVE_TOKEN_ONEINCH ||
      params.buyToken?.toLowerCase() === '0x0000000000000000000000000000000000000000';
    
    // Fetch quotes in parallel with individual error handling
    const [oneInchQuote, lifiQuote] = await Promise.allSettled([
      this.get1inchQuote(params),
      this.getLiFiQuote(params),
    ]);
    
    const validQuotes: QuoteResult[] = [];
    
    // Process 1inch quote
    if (oneInchQuote.status === 'fulfilled' && oneInchQuote.value) {
      oneInchQuote.value.netValue = this.calculateNetValue(oneInchQuote.value, isBuyingNative);
      validQuotes.push(oneInchQuote.value);
      logger.info('✅ 1inch quote retrieved successfully');
    } else {
      logger.warn('⚠️  1inch quote failed or returned null');
    }
    
    // Process LiFi quote
    if (lifiQuote.status === 'fulfilled' && lifiQuote.value) {
      lifiQuote.value.netValue = this.calculateNetValue(lifiQuote.value, isBuyingNative);
      validQuotes.push(lifiQuote.value);
      logger.info('✅ LiFi quote retrieved successfully');
    } else {
      logger.warn('⚠️  LiFi quote failed or returned null');
    }
    
    if (validQuotes.length === 0) {
      logger.error('❌ No valid quotes from any provider');
      return null;
    }
    
    logger.info(`✅ Retrieved ${validQuotes.length} valid quote(s)`);
    return validQuotes;
  }

  /**
   * Build transaction from quote
   */
  async buildTxFromQuote(quote: any, provider: string): Promise<any> {
    if (!quote) {
      throw new Error('No quote provided');
    }

    // For 1inch quotes
    if (provider === '1inch' && quote.tx) {
      return {
        to: quote.tx.to,
        data: quote.tx.data,
        value: quote.tx.value || '0',
        gas: quote.tx.gas,
        gasPrice: quote.tx.gasPrice,
      };
    }

    // For LiFi quotes
    if (provider === 'LiFi' && quote.transactionRequest) {
      return {
        to: quote.transactionRequest.to,
        data: quote.transactionRequest.data,
        value: quote.transactionRequest.value || '0',
        gas: quote.transactionRequest.gasLimit,
        gasPrice: quote.transactionRequest.gasPrice,
      };
    }

    throw new Error('Invalid quote format or unsupported provider');
  }

  /**
   * Get detailed cost breakdown
   */
  getQuoteCostBreakdown(quote: QuoteResult): {
    buyAmount: string;
    gasCost: string;
    gasCostBNB: string;
    gasPriceGwei: string;
    netValue: string;
    provider: string;
  } {
    const gasPrice = quote.gasPrice || '0';
    const gasCost = BigInt(quote.estimatedGas || '500000') * BigInt(gasPrice);
    const gasCostBNB = (Number(gasCost) / 1e18).toFixed(6);
    const gasPriceGwei = (Number(gasPrice) / 1e9).toFixed(2);

    return {
      buyAmount: quote.buyAmount,
      gasCost: gasCost.toString(),
      gasCostBNB,
      gasPriceGwei,
      netValue: quote.netValue || quote.buyAmount,
      provider: quote.provider,
    };
  }
}

export { QuoteAggregator, QuoteParams, QuoteResult, AggregatedQuoteResult, ApprovalTransaction };
