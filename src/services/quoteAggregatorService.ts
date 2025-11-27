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
  provider: '0x' | '1inch';
  quote: any;
  buyAmount: string;
  sellAmount: string;
  estimatedGas?: string;
  allowanceTarget?: string;
  gasPrice?: string;
  netValue?: string; // Net value after subtracting gas costs
}

interface AggregatedQuoteResult {
  bestQuote: QuoteResult;
  allQuotes: QuoteResult[];
  savings?: string;
  savingsType?: 'buyAmount' | 'netValue'; // Indicates what type of savings
}

class QuoteAggregator {
  private QUICKNODE_RPC: string;
  private ONEINCH_API_KEY: string;
  private CHAIN_ID = 56;
  private ONEINCH_BASE_URL = `https://api.1inch.dev/swap/v6.1/${this.CHAIN_ID}`;

  // Gas price for calculations (0.8 gwei = 800000000 wei)
  private readonly GAS_PRICE_WEI = 800000000n;

  constructor(quicknodeRpc: string, oneInchApiKey: string) {
    this.QUICKNODE_RPC = quicknodeRpc;
    this.ONEINCH_API_KEY = oneInchApiKey;
  }

  /**
   * Fetches quote from 0x API
   */
  private async get0xQuote(params: QuoteParams): Promise<QuoteResult | null> {
    try {
      const urlParams = new URLSearchParams({
        buyToken: params.buyToken,
        sellToken: params.sellToken,
        sellAmount: params.sellAmount,
        taker: params.taker,
      });

      const quoteUrl = `${this.QUICKNODE_RPC}/addon/1117/swap/allowance-holder/quote?chainId=${this.CHAIN_ID}&${urlParams.toString()}`;
      
      logger.info(`Fetching 0x quote...`);
      const quoteRes = await axios.get(quoteUrl, { timeout: 15000 });
      const quote = quoteRes.data;

      if (!quote || !quote.liquidityAvailable) {
        logger.warn(`0x: No liquidity available`);
        return null;
      }

      const estimatedGas = quote.transaction?.gas || '500000';
      const gasPrice = quote.transaction?.gasPrice || this.GAS_PRICE_WEI.toString();

      return {
        provider: '0x',
        quote: quote,
        buyAmount: quote.buyAmount || '0',
        sellAmount: quote.sellAmount || params.sellAmount,
        estimatedGas,
        gasPrice,
        allowanceTarget: quote.allowanceTarget || quote.transaction?.to,
      };
    } catch (error: any) {
      logger.error(`0x quote failed: ${error.response?.data?.reason || error.message}`);
      return null;
    }
  }

  /**
   * Fetches quote from 1inch API
   */
  private async get1inchQuote(params: QuoteParams): Promise<QuoteResult | null> {
    try {
      // 1inch uses different token representation for native tokens
      const src = params.sellToken === '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' 
        ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' 
        : params.sellToken;
      
      const dst = params.buyToken === '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
        ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
        : params.buyToken;

      const quoteParams = {
        src,
        dst,
        amount: params.sellAmount,
      };

      const url = `${this.ONEINCH_BASE_URL}/quote?${new URLSearchParams(quoteParams).toString()}`;
      
      logger.info(`Fetching 1inch quote...`);
      const response = await axios.get(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.ONEINCH_API_KEY}`,
        },
        timeout: 15000,
      });

      const quote = response.data;

      if (!quote || !quote.dstAmount) {
        logger.warn(`1inch: Invalid quote response`);
        return null;
      }

      // For swap transaction details, we need to call the /swap endpoint
      const swapParams = {
        src,
        dst,
        amount: params.sellAmount,
        from: params.taker,
        origin: params.taker,
        slippage: params.slippage || '1',
      };

      const swapUrl = `${this.ONEINCH_BASE_URL}/swap?${new URLSearchParams(swapParams).toString()}`;
      const swapResponse = await axios.get(swapUrl, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.ONEINCH_API_KEY}`,
        },
        timeout: 15000,
      });

      const swapData = swapResponse.data;

      const estimatedGas = swapData.tx?.gas || '500000';
      const gasPrice = swapData.tx?.gasPrice || this.GAS_PRICE_WEI.toString();

      return {
        provider: '1inch',
        quote: swapData,
        buyAmount: swapData.dstAmount || quote.dstAmount,
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
   * Calculate net value after gas costs
   * For buying: netValue = buyAmount - gasCost (in buy token terms)
   * For selling: netValue = buyAmount - gasCost (already in native token)
   */
  private calculateNetValue(
    quote: QuoteResult,
    isBuyingNative: boolean
  ): string {
    const buyAmount = BigInt(quote.buyAmount);
    const gasLimit = BigInt(quote.estimatedGas || '500000');
    const gasPrice = BigInt(quote.gasPrice || this.GAS_PRICE_WEI.toString());
    const gasCost = gasLimit * gasPrice;

    if (isBuyingNative) {
      // When buying native token (selling), subtract gas cost directly
      const netValue = buyAmount - gasCost;
      return netValue > 0n ? netValue.toString() : '0';
    } else {
      // When buying tokens (selling native), gas cost is in native token
      // We can't directly subtract from buyAmount (different token)
      // Return buyAmount as netValue for token purchases
      // Gas cost will be paid separately from wallet balance
      return buyAmount.toString();
    }
  }

  /**
   * Compares two quotes and returns comparison result
   * Returns: 1 if quote1 is better, -1 if quote2 is better, 0 if equal
   */
  private compareQuotes(
    quote1: QuoteResult,
    quote2: QuoteResult,
    isBuyingNative: boolean
  ): number {
    const netValue1 = BigInt(quote1.netValue || quote1.buyAmount);
    const netValue2 = BigInt(quote2.netValue || quote2.buyAmount);

    if (netValue1 > netValue2) return 1;
    if (netValue1 < netValue2) return -1;
    return 0;
  }

  /**
   * Main function to get best quote from both providers
   * Now considers net value after gas costs for better comparison
   */
  async getBestQuote(params: QuoteParams): Promise<AggregatedQuoteResult | null> {
    logger.info(`🔍 Fetching quotes from 0x and 1inch...`);

    // Determine if we're buying native token (for net value calculation)
    const isBuyingNative = params.buyToken === '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' ||
                           params.buyToken === '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

    // Fetch quotes in parallel
    const [zeroXQuote, oneInchQuote] = await Promise.all([
      this.get0xQuote(params),
      this.get1inchQuote(params),
    ]);

    const validQuotes: QuoteResult[] = [];
    
    if (zeroXQuote) {
      zeroXQuote.netValue = this.calculateNetValue(zeroXQuote, isBuyingNative);
      validQuotes.push(zeroXQuote);
    }
    
    if (oneInchQuote) {
      oneInchQuote.netValue = this.calculateNetValue(oneInchQuote, isBuyingNative);
      validQuotes.push(oneInchQuote);
    }

    if (validQuotes.length === 0) {
      logger.error('❌ No valid quotes from any provider');
      return null;
    }

    // Sort by net value (descending - higher is better)
    validQuotes.sort((a, b) => this.compareQuotes(b, a, isBuyingNative));

    const bestQuote = validQuotes[0];
    const worstQuote = validQuotes[validQuotes.length - 1];

    // Calculate savings based on net value
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

    logger.info(`✅ Best quote from ${bestQuote.provider}`);
    logger.info(`   Buy amount: ${bestQuote.buyAmount}`);
    logger.info(`   Net value (after gas): ${bestQuote.netValue}`);
    logger.info(`   Estimated gas: ${bestQuote.estimatedGas}`);
    
    if (savings) {
      logger.info(`   💰 Savings: ${savings}% better than ${worstQuote.provider} (net value comparison)`);
    }

    // Log detailed comparison
    validQuotes.forEach((q, idx) => {
      const gasCost = BigInt(q.estimatedGas || '500000') * BigInt(q.gasPrice || this.GAS_PRICE_WEI.toString());
      const gasCostEth = Number(gasCost) / 1e18;
      
      logger.info(`   ${idx + 1}. ${q.provider}:`);
      logger.info(`      • Buy amount: ${q.buyAmount}`);
      logger.info(`      • Gas: ${q.estimatedGas} (${gasCostEth.toFixed(6)} BNB)`);
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
   * Helper method to build transaction from the best quote
   */
  async buildTxFromQuote(quote: any, taker: string): Promise<any> {
    if (!quote) {
      throw new Error('No quote provided');
    }

    // For 0x quotes
    if (quote.transaction || quote.to) {
      return {
        to: quote.transaction?.to,
        data: quote.transaction?.data,
        value: quote.transaction?.value || '0',
        gas: quote.transaction.gas,
        gasPrice: quote.transaction.gasPrice,
      };
    }

    // For 1inch quotes (swap response has tx object)
    if (quote.tx) {
      return {
        to: quote.tx.to,
        data: quote.tx.data,
        value: quote.tx.value || '0',
        gas: quote.tx.gas,
        gasPrice: quote.tx.gasPrice,
      };
    }

    throw new Error('Invalid quote format');
  }

  /**
   * Get detailed cost breakdown for a quote
   */
  getQuoteCostBreakdown(quote: QuoteResult): {
    buyAmount: string;
    gasCost: string;
    gasCostBNB: string;
    netValue: string;
    provider: string;
  } {
    const gasCost = BigInt(quote.estimatedGas || '500000') * BigInt(quote.gasPrice || this.GAS_PRICE_WEI.toString());
    const gasCostBNB = (Number(gasCost) / 1e18).toFixed(6);

    return {
      buyAmount: quote.buyAmount,
      gasCost: gasCost.toString(),
      gasCostBNB,
      netValue: quote.netValue || quote.buyAmount,
      provider: quote.provider,
    };
  }
}

export { QuoteAggregator, QuoteParams, QuoteResult, AggregatedQuoteResult };