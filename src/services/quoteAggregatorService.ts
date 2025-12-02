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
  provider: 'LiFi';
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
  savings?: string;
  savingsType?: 'buyAmount' | 'netValue';
}

class QuoteAggregator {
  private LIFI_API_KEY: string;
  private CHAIN_ID = 56;
  private LIFI_BASE_URL = `https://li.quest/v1`;

  // BSC native token representations
  private readonly WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
  private readonly NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

  constructor(liFiApiKey: string) {
    this.LIFI_API_KEY = liFiApiKey;
  }

  /**
   * Normalize token address
   */
  private normalizeToken(token: string): string {
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
   * OPTIMIZED: Fetches quote from LiFi API with reduced timeout
   */
  private async getLiFiQuote(params: QuoteParams): Promise<QuoteResult | null> {
    try {
      const fromToken = this.normalizeToken(params.sellToken);
      const toToken = this.normalizeToken(params.buyToken);

      const quoteParams: any = {
        fromChain: this.CHAIN_ID.toString(),
        toChain: this.CHAIN_ID.toString(),
        fromToken: fromToken === null ? undefined : fromToken,
        toToken: toToken === null ? undefined : toToken,
        fromAmount: params.sellAmount,
        fromAddress: params.taker,
        allowUserInSimulation: 'true',
        slippage: (Number(params.slippage || '15') / 100).toString(),
      };

      Object.keys(quoteParams).forEach(
        (key) => quoteParams[key] === undefined && delete quoteParams[key]
      );

      const quoteUrl = `${this.LIFI_BASE_URL}/quote?${new URLSearchParams(quoteParams).toString()}`;

      // OPTIMIZATION: Reduced timeout from 15s to 8s for faster failure
      const quoteRes = await axios.get(quoteUrl, { 
        timeout: 8000,
        headers: {
          'x-lifi-api-key': this.LIFI_API_KEY || ''
        }
      });
      const quote = quoteRes.data;

      if (!quote || !quote.estimate || !quote.estimate.toAmount) {
        return null;
      }

      // OPTIMIZATION: Simplified gas calculation
      const gasCosts = quote.estimate.gasCosts || [];
      const totalGasEstimate = gasCosts.reduce((sum: number, cost: any) => {
        return sum + Number(cost.estimate || 0);
      }, 0);

      const estimatedGas = totalGasEstimate > 0 ? totalGasEstimate.toString() : '500000';
      const gasPrice = gasCosts[0]?.price;

      // OPTIMIZATION: Removed excessive logging

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
      // OPTIMIZATION: Simplified error logging
      logger.error(`LiFi quote failed: ${error.message}`);
      return null;
    }
  }

  /**
   * OPTIMIZED: Calculate net value (simplified)
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
   * OPTIMIZED: Get best quote from LiFi with minimal logging
   */
  async getBestQuote(params: QuoteParams): Promise<AggregatedQuoteResult | null> {

    const isBuyingNative = 
      params.buyToken === this.WBNB_ADDRESS ||
      params.buyToken === this.NATIVE_TOKEN ||
      params.buyToken?.toLowerCase() === '0x0000000000000000000000000000000000000000';

    const lifiQuote = await this.getLiFiQuote(params);

    if (!lifiQuote) {
      logger.error('❌ No quote from LiFi');
      return null;
    }

    lifiQuote.netValue = this.calculateNetValue(lifiQuote, isBuyingNative);

    return {
      bestQuote: lifiQuote,
    };
  }

  /**
   * Get quote from LiFi (kept for compatibility)
   */
  async getAllBestQuote(params: QuoteParams): Promise<QuoteResult[] | null> {
    const isBuyingNative = 
      params.buyToken === this.WBNB_ADDRESS ||
      params.buyToken === this.NATIVE_TOKEN ||
      params.buyToken?.toLowerCase() === '0x0000000000000000000000000000000000000000';

    const lifiQuote = await this.getLiFiQuote(params);

    if (!lifiQuote) {
      return null;
    }

    lifiQuote.netValue = this.calculateNetValue(lifiQuote, isBuyingNative);

    return [lifiQuote];
  }

}

export { QuoteAggregator, QuoteParams, QuoteResult, AggregatedQuoteResult };
