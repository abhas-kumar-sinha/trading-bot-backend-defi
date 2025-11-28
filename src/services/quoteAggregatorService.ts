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
  private CHAIN_ID = 56;
  private ONEINCH_BASE_URL = `https://api.1inch.dev/swap/v6.1/${this.CHAIN_ID}`;
  private LIFI_BASE_URL = `https://li.quest/v1`;

  // BSC native token representations
  private readonly WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
  private readonly NATIVE_TOKEN_ALT = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
  private readonly NATIVE_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

  constructor(oneInchApiKey: string) {
    this.ONEINCH_API_KEY = oneInchApiKey;
  }

  /**
   * Fetches quote from 1inch API
   */
  private async get1inchQuote(params: QuoteParams): Promise<QuoteResult | null> {
    try {
      const src = params.sellToken === this.WBNB_ADDRESS ? this.NATIVE_TOKEN_ALT : params.sellToken;
      const dst = params.buyToken === this.WBNB_ADDRESS ? this.NATIVE_TOKEN_ALT : params.buyToken;

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
   * LiFi is a bridge & DEX aggregator that aggregates multiple DEXs including 1inch, Uniswap, etc.
   */
  private async getLiFiQuote(params: QuoteParams): Promise<QuoteResult | null> {
    try {
      logger.info(`Fetching LiFi quote...`);

      // For same-chain swaps, both fromChain and toChain are the same
      const quoteParams = {
        fromChain: this.CHAIN_ID.toString(),
        toChain: this.CHAIN_ID.toString(),
        fromToken: params.sellToken === this.WBNB_ADDRESS ? this.NATIVE_ZERO_ADDRESS : params.sellToken,
        toToken: params.buyToken === this.WBNB_ADDRESS ? this.NATIVE_ZERO_ADDRESS : params.buyToken,
        fromAmount: params.sellAmount,
        fromAddress: params.taker,
        slippage: (Number(params.slippage || '1') / 100).toString(), // LiFi uses decimal format (0.01 for 1%)
      };

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
      params.buyToken === this.NATIVE_TOKEN_ALT ||
      params.buyToken === this.NATIVE_ZERO_ADDRESS;

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

export { QuoteAggregator, QuoteParams, QuoteResult, AggregatedQuoteResult };
