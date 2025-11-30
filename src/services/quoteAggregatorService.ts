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
   * Fetches quote from LiFi API
   */
  private async getLiFiQuote(params: QuoteParams): Promise<QuoteResult | null> {
    try {
      logger.info(`Fetching LiFi quote...`);

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
        slippage: (Number(params.slippage || '10') / 100).toString(),
      };

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
   * Get best quote from LiFi
   */
  async getBestQuote(params: QuoteParams): Promise<AggregatedQuoteResult | null> {
    logger.info(`🔍 Fetching quote from LiFi aggregator...`);

    const isBuyingNative = 
      params.buyToken === this.WBNB_ADDRESS ||
      params.buyToken === this.NATIVE_TOKEN ||
      params.buyToken?.toLowerCase() === '0x0000000000000000000000000000000000000000';

    const lifiQuote = await this.getLiFiQuote(params);

    if (!lifiQuote) {
      logger.error('❌ No valid quote from LiFi');
      return null;
    }

    lifiQuote.netValue = this.calculateNetValue(lifiQuote, isBuyingNative);

    logger.info(`\n✅ Quote from ${lifiQuote.provider}`);
    logger.info(`   Buy amount: ${lifiQuote.buyAmount}`);
    logger.info(`   Net value (after gas): ${lifiQuote.netValue}`);
    logger.info(`   Estimated gas: ${lifiQuote.estimatedGas}`);

    if (lifiQuote.gasPrice) {
      const gasCost = BigInt(lifiQuote.estimatedGas || '500000') * BigInt(lifiQuote.gasPrice);
      const gasCostBNB = Number(gasCost) / 1e18;
      const gasPriceGwei = Number(lifiQuote.gasPrice) / 1e9;
      
      logger.info(`   Gas price: ${gasPriceGwei.toFixed(2)} Gwei`);
      logger.info(`   Gas units: ${lifiQuote.estimatedGas} (${gasCostBNB.toFixed(6)} BNB)`);
    }

    return {
      bestQuote: lifiQuote,
    };
  }

  /**
   * Get quote from LiFi
   */
  async getAllBestQuote(params: QuoteParams): Promise<QuoteResult[] | null> {
    logger.info('🔍 Fetching quote from LiFi aggregator...');
    
    const isBuyingNative = 
      params.buyToken === this.WBNB_ADDRESS ||
      params.buyToken === this.NATIVE_TOKEN ||
      params.buyToken?.toLowerCase() === '0x0000000000000000000000000000000000000000';
    
    const lifiQuote = await this.getLiFiQuote(params);
    
    if (!lifiQuote) {
      logger.error('❌ No valid quote from LiFi');
      return null;
    }

    lifiQuote.netValue = this.calculateNetValue(lifiQuote, isBuyingNative);
    logger.info('✅ LiFi quote retrieved successfully');
    
    return [lifiQuote];
  }

}

export { QuoteAggregator, QuoteParams, QuoteResult, AggregatedQuoteResult };
