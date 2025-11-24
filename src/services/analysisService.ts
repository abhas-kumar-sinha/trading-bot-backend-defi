import pool, { initDB } from "../db";
import { SmartMoneyTransaction, TrendingToken, TokenAnalysis, MonitoringAlert, TradePosition } from '../types/index';
import { calculateRiskScore } from '../utils/helpers';
import logger from '../utils/logger';
import binanceApi from "./binanceApi";
import monitoringService from "./monitoringService";
import { Contract, JsonRpcProvider, parseUnits, TransactionReceipt, TransactionRequest, Wallet } from "ethers";
import { QuoteAggregator } from "./quoteAggregatorService";

interface TradePositionExtended extends TradePosition {
  smartMoneyConfirmation: boolean;
  profitTarget: number; // 10% or 15%
}

class AnalysisService {

  //aggregator
  private aggregator: QuoteAggregator;

  //Pending Phase
  private pendingBuyingTokens: Set<string> = new Set();
  private pendingSellingTokens: Set<string> = new Set();

  // Wallet connection
  private readonly QUICKNODE_RPC: string = process.env.QUICKNODE_RPC!;
  private readonly ONEINCH_API_KEY: string = process.env.ONEINCH_API_KEY!;
  private readonly PRIVATE_KEY: string = process.env.PRIVATE_KEY!;
  private readonly provider = new JsonRpcProvider(this.QUICKNODE_RPC);
  private readonly wallet = new Wallet(this.PRIVATE_KEY, this.provider);
  public readonly walletAddress: string = this.wallet.address;

  // Trade variables
  private readonly INR_TO_SPEND: number = Number(process.env.INR_TO_SPEND ?? 300);

  private trendingTokensCache: TrendingToken[] = [];
  private activePositions: Map<string, TradePositionExtended> = new Map(); // tokenCA -> position
  private dbInitialized = false;
  private readonly ANALYSIS_THRESHOLDS = {
    MIN_MARKET_CAP: 50000, // 50K min market cap
    MAX_RISK_LEVEL: 3,
    BASE_PROFIT_TARGET: 10, // 10% base profit
    BOOSTED_PROFIT_TARGET: 15, // 15% with smart money confirmation
    SMARTMONEY_CONFIRMATION_TIMEOUT: 1 * 60 * 60, // 1 hour
  };

  constructor() {
    this.aggregator = new QuoteAggregator(this.QUICKNODE_RPC, this.ONEINCH_API_KEY);
  }

  private async ensureDBReady() {
    if (!this.dbInitialized) {
      await initDB();
      this.dbInitialized = true;
    }
  }

  async ensurePositionDbSync(): Promise<void> {
    await this.ensureDBReady();

    try {
      const res = await pool.query(`SELECT * FROM trades WHERE exitTimestamp IS NULL;`);
      const rows = res.rows ?? [];

      logger.info(`🔁 Restoring ${rows.length} open positions from DB...`);

      for (const row of rows) {
        try {
          const tokenCA = (row.tokenca || row.tokenca || row.contractaddress || "").toString();
          if (!tokenCA) {
            logger.warn("Skipped DB row without tokenCA:", row);
            continue;
          }

          const position: TradePositionExtended = {
            tokenCA: tokenCA,
            tokenSymbol: row.tokensymbol || row.tokenSymbol || row.tokenname || "UNKNOWN",
            tokenName: row.tokenname || row.tokenName || row.tokensymbol || "UNKNOWN",
            walletAddress: row.walletaddress || row.walletAddress || "",
            entryPrice: row.entryprice !== null ? Number(row.entryprice) : 0,
            entryMarketCap: row.entrymarketcap !== null ? Number(row.entrymarketcap) : 0,
            entryTimestamp: row.entrytimestamp !== null ? Number(row.entrytimestamp) : Date.now(),
            entryTxHash: row.entrytxhash || row.entryTxHash || "",
            myBuyOrderTx: row.mybuyordertx || row.myBuyOrderTx || "",
            tokenDetails: (typeof row.tokendetails === "string")
              ? JSON.parse(row.tokendetails)
              : row.tokendetails || {},
            smartMoneyConfirmation: (typeof row.smartmoneyconfirmation === "boolean")
              ? row.smartmoneyconfirmation
              : !!row.smartMoneyConfirmation || false,
            profitTarget: row.profittarget !== null ? Number(row.profittarget) : this.ANALYSIS_THRESHOLDS.BASE_PROFIT_TARGET,
          };

          // restore in-memory map
          this.activePositions.set(position.tokenCA.toLowerCase(), position);

          logger.info(`🔁 Restored position: ${position.tokenSymbol} (${position.tokenCA})`);

        } catch (innerErr) {
          logger.error("Error restoring row into position map:", innerErr, row);
        }
      }

      logger.info("✅ Position/WS DB sync complete.");
    } catch (err) {
      logger.error("❌ Failed to sync positions from DB on startup:");
    }
  }

  private timeAgo(ts: number): number {
    const now = Date.now(); // current time in milliseconds
    const diffSec = Math.floor((now - ts * 1000) / 1000); // difference in seconds
  
    return diffSec;
  }

  updateTrendingCache(trendingTokens: TrendingToken[]): void {
    this.trendingTokensCache = trendingTokens;
    logger.info(`Updated trending tokens cache with ${trendingTokens.length} tokens`);
  }

  /**
   * Primary analysis for FOLLOWING wallet transactions
   * This is the main buy signal
   */
  analyzeFollowingTransaction(transaction: SmartMoneyTransaction): MonitoringAlert | null {
    const txValue = parseFloat(transaction.txUsdValue);
    const marketCap = parseFloat(transaction.marketCap);
    const riskScore = calculateRiskScore(transaction);

    // Only process BUY transactions (tradeSideCategory 11 or 19)
    const isBuy = transaction.tradeSideCategory === 11 || transaction.tradeSideCategory === 19;
    const isSell = transaction.tradeSideCategory === 21 || transaction.tradeSideCategory === 29;
    const timePassed = this.timeAgo(transaction.ts);

    if (isBuy && timePassed < 10 && marketCap >= this.ANALYSIS_THRESHOLDS.MIN_MARKET_CAP) {
      // Create buy signal
      return {
        type: 'FOLLOWING_BUY',
        timestamp: Date.now(),
        data: {
          ...transaction,
          riskScore,
          analysisType: 'FOLLOWING',
          action: 'BUY'
        },
        priority: 'CRITICAL',
        message: `🎯 FOLLOWING WALLET BUY: ${transaction.tokenName} - ${txValue.toFixed(2)} USD`
      };
    } else if (isSell && timePassed < 30) {
      // Check if we have an active position for this token
      const position = this.activePositions.get(transaction.ca.toLowerCase());
      
      if (position && position.walletAddress === transaction.address) {
        // The wallet we followed is selling - create sell signal
        return {
          type: 'FOLLOWING_SELL',
          timestamp: Date.now(),
          data: {
            ...transaction,
            riskScore,
            analysisType: 'FOLLOWING',
            action: 'SELL',
            reason: 'WALLET_SOLD'
          },
          priority: 'HIGH',
          message: `🔴 FOLLOWING WALLET SELL: ${transaction.tokenName} - Exit position`
        };
      }
    }

    return null;
  }

  /**
   * Secondary analysis for smart money/KOL/Following transactions
   * Used only for confirmation and profit target adjustment
   */
  analyzeSmartMoneyForConfirmation(transaction: SmartMoneyTransaction, type: 'SMART_MONEY' | 'KOL' | 'FOLLOWING'): void {
    const isBuy = transaction.tradeSideCategory === 11 || transaction.tradeSideCategory === 19;
    
    if (!isBuy) return;

    const tokenCA = transaction.ca.toLowerCase();
    const position = this.activePositions.get(tokenCA);

    // If we have an active position and smart money/KOL/following is buying after us
    if (position && !position.smartMoneyConfirmation) {
      const txValue = parseFloat(transaction.txUsdValue);
      
      // Significant smart money activity (> $2000) or following activity (> $1000)
      if (((txValue >= 2000) && (type === 'SMART_MONEY' || type === 'KOL') || (type === 'FOLLOWING' && txValue >= 1000)) && transaction.address !== position.walletAddress) {
        position.smartMoneyConfirmation = true;
        position.profitTarget = this.ANALYSIS_THRESHOLDS.BOOSTED_PROFIT_TARGET;

        this.updatePositionMetadataToDb(position);
        
        logger.info(`✨ Smart money confirmation for ${position.tokenSymbol} - Profit target increased to ${position.profitTarget}%`);
      }
    }
  }

  /**
   * Active Position monitoring
   * Used for reseting the smart money confirmation
   */
  monitorPosition(position: TradePositionExtended): void {
    const entryTimeMs = position.entryTimestamp;
    const now = Date.now();
    const diffSec = Math.floor((now - entryTimeMs) / 1000);

    logger.info(`checking position: ${position.tokenSymbol} - ${diffSec} seconds passed`)
    
    if (diffSec > this.ANALYSIS_THRESHOLDS.SMARTMONEY_CONFIRMATION_TIMEOUT) {
      position.smartMoneyConfirmation = false;
      position.profitTarget = this.ANALYSIS_THRESHOLDS.BASE_PROFIT_TARGET;
      
      this.updatePositionMetadataToDb(position);
      
      logger.info(`✨ Smart money confirmation reset for ${position.tokenSymbol} - Profit target reset to ${position.profitTarget}%`);
    }
    
    
  }


  async updatePositionMetadataToDb(position: TradePositionExtended): Promise<void> {
    try {
      await pool.query(
        `UPDATE trades SET smartmoneyconfirmation = $1, profittarget = $2 WHERE tokenca = $3;`,
        [position.smartMoneyConfirmation, position.profitTarget, position.tokenCA]
      );
    } catch (err) {
      logger.error("❌ Error updating position metadata:");
    }
  }

  private jsonObjectBigIntSafe<T>(value: T): T {
    return JSON.parse(
      JSON.stringify(value, (_key, val) =>
        typeof val === "bigint" ? val.toString() : val
      )
    );
  }

  private async sendAndWait(txRequest: TransactionRequest, timeoutMs = 120_000) {
    const signedTx = await this.wallet.sendTransaction(txRequest);
    const hash = signedTx.hash;
    logger.info(`Broadcasted tx ${hash} - waiting for 1 confirmation (timeout ${timeoutMs}ms)`);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("tx confirmation timeout")), timeoutMs));
    try {
      const receipt = await Promise.race([signedTx.wait(1), timeout]) as TransactionReceipt;
      logger.info(`✅ Tx confirmed: ${hash}`);
      return receipt;
    } catch (err) {
      logger.error(`❌ Tx failed or timed out: ${hash}`);
      throw err;
    }
  }

  /**
   * Execute buy order (semi-dummy implementation)
   */
  async executeBuyOrder(transaction: SmartMoneyTransaction): Promise<TradePositionExtended | null> {
    try {

      if (this.pendingBuyingTokens.has(transaction.txHash)) return;

      this.pendingBuyingTokens.add(transaction.txHash);

      let txReq: TransactionRequest;

      try {
        const currentBNBPrice = monitoringService.activeWebSockets.get(
          monitoringService.NATIVE_TOKEN_DATA
        )?.lastPrice;

        if (!currentBNBPrice) {
          logger.warn("❌ No BNB price found");
          this.pendingBuyingTokens.delete(transaction.txHash);
          return null;
        }

        const bnbToSpend = this.INR_TO_SPEND / (currentBNBPrice * 85);
        const amountInWei = parseUnits(bnbToSpend.toFixed(18), 18);

        // Get best quote from both providers
        const result = await this.aggregator.getBestQuote({
          sellToken: monitoringService.NATIVE_TOKEN_TRADES, // WBNB
          buyToken: transaction.ca, // Target token
          sellAmount: amountInWei.toString(),
          taker: this.walletAddress,
          slippage: '1', // 1% slippage
        });

        if (!result) {
          logger.info(`No valid quotes available for buy`);
          this.pendingBuyingTokens.delete(transaction.txHash);
          return null;
        }

        // Build transaction from best quote
        txReq = await this.aggregator.buildTxFromQuote(
          result.bestQuote.quote,
          this.walletAddress
        );

        logger.info(`✅ BUY ORDER using ${result.bestQuote.provider}`);
        
      } catch (error) {
        this.pendingBuyingTokens.delete(transaction.txHash);
        logger.error("❌ Error executing buy order:", error);
        return null;
      }

      // This is to store the token details
      await new Promise(resolve => setTimeout(resolve, 2000));
      const currentMarketDynamics = await binanceApi.getTokenMarketDynamics(transaction.ca);
      const marketCap = parseFloat(currentMarketDynamics.marketCap);
      const price = parseFloat(currentMarketDynamics.price);
      const timestamp = Date.now();
      const safeTx = this.jsonObjectBigIntSafe(txReq);

      logger.info(`BUY ORDER for ${transaction.tokenName}: ${JSON.stringify(safeTx)}`)

      // Fetch additional token details
      const tokenDetails = {
        contractAddress: transaction.ca,
        symbol: transaction.tokenName,
        name: transaction.tokenName,
        marketCap: marketCap,
        price: price,
        volume24h: parseFloat(transaction.txUsdValue),
        count5m: parseFloat(currentMarketDynamics.count5m),
        priceChange24h: parseFloat(currentMarketDynamics.percentChange24h),
        launchTime: parseFloat(currentMarketDynamics.launchTime),
        liquidity: parseFloat(currentMarketDynamics.liquidity),
        holders: parseFloat(currentMarketDynamics.holders),
        kycHolderCount: parseFloat(currentMarketDynamics.kycHolderCount),
        top10HoldersPercentage: parseFloat(currentMarketDynamics.top10HoldersPercentage),
        holdersSmartMoneyPercent: parseFloat(currentMarketDynamics.holdersSmartMoneyPercent),
        holdersInfluencersPercent: parseFloat(currentMarketDynamics.holdersInfluencersPercent),
        tokenHigh: 0,
        tokenLow: 0,
      };

      const position: TradePositionExtended = {
        tokenCA: transaction.ca,
        tokenSymbol: transaction.tokenName,
        tokenName: transaction.tokenName,
        walletAddress: transaction.address,
        entryPrice: price,
        entryMarketCap: marketCap,
        entryTimestamp: timestamp,
        entryTxHash: transaction.txHash,
        myBuyOrderTx: safeTx,
        tokenDetails: tokenDetails,
        smartMoneyConfirmation: false,
        profitTarget: this.ANALYSIS_THRESHOLDS.BASE_PROFIT_TARGET
      };

      // Store position
      this.activePositions.set(transaction.ca.toLowerCase(), position);

      // Save to database (implement your DB logic)
      await this.savePositionToDB(position);

      logger.info(`💰 BUY ORDER EXECUTED: ${position.tokenSymbol} at $${price} (MC: $${marketCap})`);
      this.pendingBuyingTokens.delete(transaction.txHash);
      return position;
    } catch (error) {
      this.pendingBuyingTokens.delete(transaction.txHash);
      logger.error('Error executing buy order:', error);
      return null;
    }
  }

  /**
   * Check if position should be sold
   */
  async checkSellConditions(position: TradePositionExtended, currentPrice: number, currentMarketCap: number): Promise<{ shouldSell: boolean; reason: string } | null> {
    logger.info(`✅🪲Checking sell conditions for ${position.tokenSymbol}`);
    const priceChange = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    const mcChange = ((currentMarketCap - position.entryMarketCap) / position.entryMarketCap) * 100;
    logger.info(`Price change: ${priceChange.toFixed(2)}%, Market cap change: ${mcChange.toFixed(2)}%`);
    // Check if profit target is met
    if (priceChange >= position.profitTarget || mcChange >= position.profitTarget) {
      return {
        shouldSell: true,
        reason: `PROFIT_TARGET_MET: ${priceChange.toFixed(2)}% profit (Target: ${position.profitTarget}%)`
      };
    }

    return null;
  }

  /**
   * Execute sell order (dummy implementation)
   */
  async executeSellOrder(position: TradePositionExtended, reason: string): Promise<void> {
    try {

      if (this.pendingSellingTokens.has(position.entryTxHash)) return;
      this.pendingSellingTokens.add(position.entryTxHash);

      let txReq: TransactionRequest;

      try {
        const taker = this.walletAddress;
        const tokenAddress = position.tokenCA;

        // ERC20 helper
        const ERC20 = new Contract(tokenAddress, [
          "function balanceOf(address owner) view returns (uint256)",
          "function allowance(address owner, address spender) view returns (uint256)",
          "function approve(address spender, uint256 amount) returns (bool)",
          "function decimals() view returns (uint8)"
        ], this.wallet);

        let balance: BigInt = await ERC20.balanceOf(taker);
        if (balance === 0n) {
          logger.warn(`No token balance to sell for ${tokenAddress}`);
          balance = 1n * 100000000000000000n; // Temporary for testing
        }

        logger.info(`Preparing sell for full balance for ${tokenAddress}`);

        // Get best quote from both providers
        const result = await this.aggregator.getBestQuote({
          sellToken: tokenAddress,
          buyToken: monitoringService.NATIVE_TOKEN_TRADES, // WBNB
          sellAmount: balance.toString(),
          taker,
          slippage: '1',
        });

        if (!result) {
          logger.info(`No valid quotes available for sell`);
          this.pendingSellingTokens.delete(position.entryTxHash);
          return null;
        }

        // Handle approval if needed
        const allowanceTarget = result.bestQuote.allowanceTarget;
        if (allowanceTarget) {
          const allowance: BigInt = await ERC20.allowance(taker, allowanceTarget);

          if (allowance < balance) {
            logger.info(`Approving ${result.bestQuote.provider} allowanceTarget for sell`);
            const approveTx = await ERC20.approve(allowanceTarget, balance);
            logger.info("Approve tx sent - waiting 1 conf");
            await approveTx.wait(1);
            logger.info("Approve confirmed");
          } else {
            logger.debug("Sufficient allowance present for allowanceTarget");
          }
        }

        // Build transaction from best quote
        txReq = await this.aggregator.buildTxFromQuote(
          result.bestQuote.quote,
          taker
        );

        logger.info(`✅ SELL ORDER for ${position.tokenName} using ${result.bestQuote.provider}`);
        this.pendingSellingTokens.delete(position.entryTxHash);
        
      } catch (error) {
        this.pendingSellingTokens.delete(position.entryTxHash);
        logger.error("❌ Error executing sell order:", error);
        return;
      }

      // This is to store the token details
      await new Promise(resolve => setTimeout(resolve, 2000));
      const currentMarketPrice = monitoringService.activeWebSockets.get(position.tokenCA);
      const currentMarketDynamics = await binanceApi.getTokenMarketDynamics(position.tokenCA);
      const totalSupply = parseFloat(currentMarketDynamics.totalSupply || 0);
      const circulatingSupply = parseFloat(currentMarketDynamics.circulatingSupply || 0);
      const currentPrice = currentMarketPrice.lastPrice;

      // Choose which supply to use
      const supplyToUse =
        circulatingSupply < totalSupply ? circulatingSupply : totalSupply;

      // Calculate market cap
      const currentMarketCap = currentPrice * supplyToUse;
      const priceChange = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      const mcChange = ((currentMarketCap - position.entryMarketCap) / position.entryMarketCap) * 100;
      const timestamp = Date.now();
      const holdingDuration = timestamp - position.entryTimestamp;
      const safeTx = this.jsonObjectBigIntSafe(txReq);

      logger.info(`SELL ORDER for ${position.tokenName}: ${JSON.stringify(safeTx)}`)

      const sellRecord = {
        ...position,
        mySellOrderTx: safeTx,
        exitPrice: currentPrice,
        exitMarketCap: currentMarketCap,
        exitTimestamp: timestamp,
        priceChangePercent: priceChange,
        marketCapChangePercent: mcChange,
        holdingDurationMs: holdingDuration,
        exitReason: reason,
        profitLoss: priceChange // In percentage
      };

      // Save to database
      await this.saveSellToDB(sellRecord);

      // Remove from active positions
      this.activePositions.delete(position.tokenCA.toLowerCase());

      logger.info(`💸 SELL ORDER EXECUTED: ${position.tokenSymbol} at $${currentPrice} (${priceChange.toFixed(2)}% P/L) - Reason: ${reason}`);
    } catch (error) {
      this.pendingSellingTokens.delete(position.entryTxHash);
      logger.error('Error executing sell order:', error);
    }
  }

  /**
   * Generate token analysis for a specific contract address
   */
  generateTokenAnalysis(
    contractAddress: string,
    smartMoneyTxs: SmartMoneyTransaction[],
    kolTxs: SmartMoneyTransaction[],
    followingTxs: SmartMoneyTransaction[],
    trendingTokens: TrendingToken[]
  ): TokenAnalysis | null {
    const relevantSmartMoney = smartMoneyTxs.filter(tx => tx.ca.toLowerCase() === contractAddress.toLowerCase());
    const relevantKOL = kolTxs.filter(tx => tx.ca.toLowerCase() === contractAddress.toLowerCase());
    const relevantFollowing = followingTxs.filter(tx => tx.ca.toLowerCase() === contractAddress.toLowerCase());
    const trendingToken = trendingTokens.find(token => token.contractAddress.toLowerCase() === contractAddress.toLowerCase());

    if (relevantFollowing.length === 0) {
      return null; // Only analyze tokens with following activity
    }

    const smartMoneyVolume = relevantSmartMoney.reduce((sum, tx) => sum + parseFloat(tx.txUsdValue), 0);
    const kolVolume = relevantKOL.reduce((sum, tx) => sum + parseFloat(tx.txUsdValue), 0);
    const followingVolume = relevantFollowing.reduce((sum, tx) => sum + parseFloat(tx.txUsdValue), 0);

    let recommendation: 'BUY' | 'HOLD' | 'SELL' | 'AVOID' = 'HOLD';
    let confidence = 0.5;

    // Prioritize following transactions
    const followingBuys = relevantFollowing.filter(tx => tx.tradeSideCategory === 11 || tx.tradeSideCategory === 19);
    const followingSells = relevantFollowing.filter(tx => tx.tradeSideCategory === 21 || tx.tradeSideCategory === 29);

    const buyVolume = followingBuys.reduce((sum, tx) => sum + parseFloat(tx.txUsdValue), 0);
    const sellVolume = followingSells.reduce((sum, tx) => sum + parseFloat(tx.txUsdValue), 0);
    const netFlow = buyVolume - sellVolume;

    // Risk assessment
    const avgRiskLevel = relevantFollowing.length > 0 
      ? relevantFollowing.reduce((sum, tx) => sum + tx.tokenRiskLevel, 0) / relevantFollowing.length
      : trendingToken?.auditInfo.riskLevel || 0;

    // Recommendation logic based on following wallets
    if (avgRiskLevel > this.ANALYSIS_THRESHOLDS.MAX_RISK_LEVEL) {
      recommendation = 'AVOID';
      confidence = 0.8;
    } else if (netFlow > 1000 && followingBuys.length > 0) {
      recommendation = 'BUY';
      confidence = 0.8;
    } else if (netFlow < -1000 && followingSells.length > 0) {
      recommendation = 'SELL';
      confidence = 0.75;
    }

    const sampleTx = relevantFollowing[0];
    
    return {
      contractAddress,
      symbol: trendingToken?.symbol || sampleTx?.tokenName || 'UNKNOWN',
      name: trendingToken?.metaInfo.name || sampleTx?.tokenName || 'Unknown Token',
      isTrending: !!trendingToken,
      riskLevel: Math.round(avgRiskLevel),
      smartMoneyActivity: relevantSmartMoney.length,
      kolActivity: relevantKOL.length,
      followingActivity: relevantFollowing.length,
      priceChange24h: trendingToken ? parseFloat(trendingToken.percentChange24h) : 0,
      volume24h: trendingToken ? parseFloat(trendingToken.volume24h) : followingVolume,
      marketCap: trendingToken ? parseFloat(trendingToken.marketCap) : parseFloat(sampleTx?.marketCap || '0'),
      recommendation,
      confidence
    };
  }

  async getTokenPosition(address: string): Promise<TradePositionExtended[] | undefined> {
    const closedPositions = await this.getClosedPositions();
    const allPositions = [...this.activePositions.values(), ...closedPositions];

    const tokenPosition: TradePositionExtended[] | undefined = allPositions.filter(position => position.tokenCA.toLowerCase() === address.toLowerCase());

    return tokenPosition;
  }

  getActivePositions(): TradePositionExtended[] {
    return Array.from(this.activePositions.values());
  }

  getPosition(tokenCA: string): TradePositionExtended | undefined {
    return this.activePositions.get(tokenCA.toLowerCase());
  }

  async getClosedPositions(): Promise<TradePositionExtended[]> {
    const closedPositions = await pool.query(`SELECT * FROM trades WHERE exitTimestamp IS NOT NULL`);
    const rows = closedPositions.rows ?? [];

    const result: TradePositionExtended[] = [];

    for (const row of rows) {
      try {
          const tokenCA = (row.tokenca || "").toString();
          if (!tokenCA) {
            logger.warn("Skipped DB row without tokenCA:", row);
            continue;
          }

          const position: TradePositionExtended = {
            tokenCA: tokenCA,
            tokenSymbol: row.tokensymbol || row.tokenSymbol || row.tokenname || "UNKNOWN",
            tokenName: row.tokenname || row.tokenName || row.tokensymbol || "UNKNOWN",
            walletAddress: row.walletaddress || row.walletAddress || "",
            entryPrice: row.entryprice !== null ? Number(row.entryprice) : 0,
            entryMarketCap: row.entrymarketcap !== null ? Number(row.entrymarketcap) : 0,
            entryTimestamp: row.entrytimestamp !== null ? Number(row.entrytimestamp) : Date.now(),
            entryTxHash: row.entrytxhash || row.entryTxHash || "",
            myBuyOrderTx: row.mybuyordertx || row.myBuyOrderTx || {},
            tokenDetails: (typeof row.tokendetails === "string")
              ? JSON.parse(row.tokendetails)
              : row.tokendetails || {},
            smartMoneyConfirmation: (typeof row.smartmoneyconfirmation === "boolean")
              ? row.smartmoneyconfirmation
              : !!row.smartMoneyConfirmation || false,
            profitTarget: row.profittarget !== null ? Number(row.profittarget) : this.ANALYSIS_THRESHOLDS.BASE_PROFIT_TARGET,
            mySellOrderTx: row.mybuyordertx || row.myBuyOrderTx || {},
            exitPrice: row.exitprice !== null ? Number(row.exitprice) : 0,
            exitMarketCap: row.exitmarketcap !== null ? Number(row.exitmarketcap) : 0,
            exitTimestamp: row.exittimestamp !== null ? Number(row.exittimestamp) : Date.now(),
            priceChangePercent: row.pricechangepercent !== null ? Number(row.pricechangepercent) : 0,
            marketCapChangePercent: row.marketcapchangepercent !== null ? Number(row.marketcapchangepercent) : 0,
            holdingDurationMs: row.holdingdurationms !== null ? Number(row.holdingdurationms) : 0,
            exitReason: row.exitreason || row.exitReason || "",
            profitLoss: row.profitloss !== null ? Number(row.profitloss) : 0,
          };

          result.push(position);
        } catch (error) {
          logger.error("Error processing DB row:", error);
        }
      }

      return result;
  }

  async getWalletBalance(): Promise<{timestamp: number, profitLoss: number}[]> {
    try {
      const { rows } = await pool.query(`SELECT * FROM trades WHERE exitTimestamp IS NOT NULL`);
      const walletBalance = rows.map(row => {
        return {
          timestamp: Number(row.exittimestamp),
          profitLoss: Number(row.profitloss)
        };
      });

      return walletBalance;
    } catch (error) {
      logger.error('Error getting wallet balance:', error);
      throw error;
    }
  }

  private async savePositionToDB(position: TradePositionExtended): Promise<void> {
    try {
      await this.ensureDBReady();
      await pool.query(
        `INSERT INTO trades (
          tokenCA, tokenSymbol, tokenName, walletAddress, entryPrice, entryMarketCap,
          entryTimestamp, entryTxHash, tokenDetails, myBuyOrderTx, smartMoneyConfirmation, profitTarget
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (entryTxHash) DO NOTHING;`,
        [
          position.tokenCA,
          position.tokenSymbol,
          position.tokenName,
          position.walletAddress,
          position.entryPrice,
          position.entryMarketCap,
          position.entryTimestamp,
          position.entryTxHash,
          JSON.stringify(position.tokenDetails),
          JSON.stringify(position.myBuyOrderTx),
          position.smartMoneyConfirmation,
          position.profitTarget,
        ]
      );

      logger.info(`✅ Position saved: ${position.tokenSymbol}`);
    } catch (err) {
      logger.error("❌ Error saving position:", err);
    }
  }

  // Update same record with sell data
  private async saveSellToDB(sellRecord: TradePositionExtended): Promise<void> {
    try {
      await this.ensureDBReady();
      const res = await pool.query(
        `UPDATE trades
         SET
           tokenDetails = $1,
           mySellOrderTx = $2,
           exitPrice = $3,
           exitMarketCap = $4,
           exitTimestamp = $5,
           priceChangePercent = $6,
           marketCapChangePercent = $7,
           holdingDurationMs = $8,
           exitReason = $9,
           profitLoss = $10
         WHERE entryTxHash = $11
         RETURNING tokenSymbol;`,
        [
          JSON.stringify(sellRecord.tokenDetails),
          JSON.stringify(sellRecord.mySellOrderTx),
          sellRecord.exitPrice ?? null,
          sellRecord.exitMarketCap ?? null,
          sellRecord.exitTimestamp ?? null,
          sellRecord.priceChangePercent ?? null,
          sellRecord.marketCapChangePercent ?? null,
          sellRecord.holdingDurationMs ?? null,
          sellRecord.exitReason ?? null,
          sellRecord.profitLoss ?? null,
          sellRecord.entryTxHash,
        ]
      );

      if (res.rowCount === 0) {
        logger.warn(`⚠️ No matching trade found for entryTxHash: ${sellRecord.entryTxHash}`);
      } else {
        logger.info(`✅ Sell data updated for: ${res.rows[0].tokensymbol}`);
      }
    } catch (err) {
      logger.error("❌ Error updating sell record:", err);
    }
  }


}

export default new AnalysisService();
