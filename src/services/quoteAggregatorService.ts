import axios from 'axios';
import logger from '../utils/logger';

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

class QuoteAggregator {
  private ONEINCH_API_KEY: string;
  private LIFI_API_KEY: string;
  private CHAIN_ID = 56;
  private ONEINCH_BASE_URL = `https://api.1inch.dev/swap/v6.1/${this.CHAIN_ID}`;
  private LIFI_BASE_URL = `https://li.quest/v1`;

  // BSC native token representations
  private readonly WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
  // 1inch uses this standard address for native token on ALL chains
  private readonly NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

  constructor(oneInchApiKey: string, liFiApiKey: string) {
    this.ONEINCH_API_KEY = oneInchApiKey;
    this.LIFI_API_KEY = liFiApiKey;
  }

  /**
   * Normalize token address to 1inch format
   * Returns the standard native token address if it's BNB
   */
  private normalize1inchToken(token: string): string {
    if (
      token === this.WBNB_ADDRESS ||
      token === this.NATIVE_TOKEN ||
      token?.toLowerCase() === '0x0000000000000000000000000000000000000000'
    ) {
      return this.NATIVE_TOKEN;
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
      token === this.NATIVE_TOKEN ||
      token?.toLowerCase() === '0x0000000000000000000000000000000000000000'
    ) {
      return this.NATIVE_TOKEN;
    }
    return token;
  }

  /**
   * Fetches quote from 1inch API
   * 1inch uses 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE for native tokens
   */
  private async get1inchQuote(params: QuoteParams): Promise<QuoteResult | null> {
    try {
      const src = this.normalize1inchToken(params.sellToken);
      const dst = this.normalize1inchToken(params.buyToken);

      const swapParams = {
        src,
        dst,
        amount: params.sellAmount,
        from: params.taker,
        origin: params.taker,
        disableEstimate: 'true',
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
        allowUserInSimulation: 'true',
        slippage: (Number(params.slippage || '1') / 100).toString(), // LiFi uses decimal format (0.01 for 1%)
      };

      // Remove undefined keys for cleaner API call
      Object.keys(quoteParams).forEach(
        (key) => quoteParams[key] === undefined && delete quoteParams[key]
      );

      const quoteUrl = `${this.LIFI_BASE_URL}/quote?${new URLSearchParams(quoteParams).toString()}`;
      const quoteRes = await axios.get(quoteUrl, { 
        timeout: 15000,
        headers: {
          'x-lifi-api-key': this.LIFI_API_KEY || ''
        }
      });
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
      params.buyToken === this.NATIVE_TOKEN ||
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
      params.buyToken === this.NATIVE_TOKEN ||
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
   * Fixed: Properly handles LiFi transactionRequest structure
   */
  async buildTxFromQuote(quote: any, provider: string): Promise<any> {
    if (!quote) {
      throw new Error('No quote provided');
    }

    try {
      // For 1inch quotes
      if (provider === '1inch' && quote.tx) {
        return {
          to: quote.tx.to,
          data: quote.tx.data,
          value: quote.tx.value || '0',
          gas: quote.tx.gas,
          gasPrice: quote.tx.gasPrice,
          from: quote.tx.from,
        };
      }

      // For LiFi quotes - FIXED: Use transactionRequest from the main quote object
      // The quote structure is: { transactionRequest: {...}, estimate: {...}, ... }
      if (provider === 'LiFi') {
        const txRequest = quote.transactionRequest;
        
        if (!txRequest) {
          logger.error('❌ LiFi quote missing transactionRequest');
          throw new Error('LiFi quote does not contain transactionRequest');
        }

        // LiFi transactionRequest structure: { to, data, value, gasLimit }
        // gasLimit is in hex format
        return {
          to: txRequest.to,
          data: txRequest.data,
          value: txRequest.value || '0',
          gas: txRequest.gasLimit ? parseInt(txRequest.gasLimit, 16).toString() : undefined,
          gasPrice: undefined, // LiFi doesn't include gasPrice in transactionRequest
          from: quote.action?.fromAddress, // From address may be in action object
        };
      }

      throw new Error(`Unsupported provider: ${provider}`);
    } catch (error: any) {
      logger.error(`❌ Failed to build transaction from ${provider} quote: ${error.message}`);
      throw error;
    }
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

export { QuoteAggregator, QuoteParams, QuoteResult, AggregatedQuoteResult };