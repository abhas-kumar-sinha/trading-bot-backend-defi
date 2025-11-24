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
}

interface AggregatedQuoteResult {
  bestQuote: QuoteResult;
  allQuotes: QuoteResult[];
  savings?: string; // how much better the best quote is
}

class QuoteAggregator {
  private QUICKNODE_RPC: string;
  private ONEINCH_API_KEY: string;
  private CHAIN_ID = 56;
  private ONEINCH_BASE_URL = `https://api.1inch.dev/swap/v6.1/${this.CHAIN_ID}`;

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

      return {
        provider: '0x',
        quote: quote,
        buyAmount: quote.buyAmount || '0',
        sellAmount: quote.sellAmount || params.sellAmount,
        estimatedGas: quote.transaction.gas,
        allowanceTarget: quote.allowanceTarget || quote.transaction.to,
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

      return {
        provider: '1inch',
        quote: swapData,
        buyAmount: swapData.dstAmount || quote.dstAmount,
        sellAmount: params.sellAmount,
        estimatedGas: swapData.tx?.gas,
        allowanceTarget: swapData.tx?.to, // 1inch router address
      };
    } catch (error: any) {
      logger.error(`1inch quote failed: ${error.response?.data?.description || error.message}`);
      return null;
    }
  }

  /**
   * Compares two quotes and returns the better one
   */
  private compareBuyAmounts(amount1: string, amount2: string): number {
    const bn1 = BigInt(amount1);
    const bn2 = BigInt(amount2);
    if (bn1 > bn2) return 1;
    if (bn1 < bn2) return -1;
    return 0;
  }

  /**
   * Main function to get best quote from both providers
   */
  async getBestQuote(params: QuoteParams): Promise<AggregatedQuoteResult | null> {
    logger.info(`🔍 Fetching quotes from 0x and 1inch...`);

    // Fetch quotes in parallel
    const [zeroXQuote, oneInchQuote] = await Promise.all([
      this.get0xQuote(params),
      this.get1inchQuote(params),
    ]);

    const validQuotes: QuoteResult[] = [];
    if (zeroXQuote) validQuotes.push(zeroXQuote);
    if (oneInchQuote) validQuotes.push(oneInchQuote);

    if (validQuotes.length === 0) {
      logger.error('❌ No valid quotes from any provider');
      return null;
    }

    // Sort by buyAmount (descending - higher is better)
    validQuotes.sort((a, b) => this.compareBuyAmounts(b.buyAmount, a.buyAmount));

    const bestQuote = validQuotes[0];
    const worstQuote = validQuotes[validQuotes.length - 1];

    // Calculate savings if we have multiple quotes
    let savings: string | undefined;
    if (validQuotes.length > 1) {
      const bestAmount = BigInt(bestQuote.buyAmount);
      const worstAmount = BigInt(worstQuote.buyAmount);
      const diff = bestAmount - worstAmount;
      const percentage = (Number(diff) / Number(worstAmount)) * 100;
      savings = percentage.toFixed(2);
    }

    logger.info(`✅ Best quote from ${bestQuote.provider}`);
    logger.info(`   Buy amount: ${bestQuote.buyAmount}`);
    if (savings) {
      logger.info(`   💰 Savings: ${savings}% better than ${worstQuote.provider}`);
    }

    // Log all quotes for comparison
    validQuotes.forEach((q, idx) => {
      logger.info(`   ${idx + 1}. ${q.provider}: ${q.buyAmount} (gas: ${q.estimatedGas || 'N/A'})`);
    });

    return {
      bestQuote,
      allQuotes: validQuotes,
      savings,
    };
  }

  /**
   * Helper method to build transaction from the best quote
   */
  async buildTxFromQuote(quote: any, taker: string): Promise<any> {
    // The quote structure will depend on the provider
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
}

export { QuoteAggregator, QuoteParams, QuoteResult, AggregatedQuoteResult };