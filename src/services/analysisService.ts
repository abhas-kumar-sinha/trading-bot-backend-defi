import pool, { initDB } from "../db";
import { SmartMoneyTransaction, TrendingToken, TokenAnalysis, MonitoringAlert, TradePositionExtended, MarketDynamicsApi } from '../types/index';
import { calculateRiskScore } from '../utils/helpers';
import logger from '../utils/logger';

class AnalysisService {
  private trendingTokensCache: TrendingToken[] = [];
  public activePositions: Map<string, TradePositionExtended> = new Map(); // token entry Txn Hash -> position
  private dbInitialized = false;
  public readonly ANALYSIS_THRESHOLDS = {
    MIN_MARKET_CAP: 30000, // 30K min market cap
    MAX_RISK_LEVEL: 3,
    BASE_PROFIT_TARGET: 10, // 10% base profit
    BOOSTED_PROFIT_TARGET: 15, // 15% with smart money confirmation
    SMARTMONEY_CONFIRMATION_TIMEOUT: 1 * 60 * 60, // 1 hour
    HOLD_DURATION_TIMEOUT: 4 * 60 * 60, //4 hour
  };

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
          this.activePositions.set(position.entryTxHash, position);

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
  }

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
      const position = this.activePositions.get(transaction.txHash);
      
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

  analyzeSmartMoneyForConfirmation(transaction: SmartMoneyTransaction, type: 'SMART_MONEY' | 'KOL' | 'FOLLOWING'): void {
    const isBuy = transaction.tradeSideCategory === 11 || transaction.tradeSideCategory === 19;
    
    if (!isBuy) return;

    const position = this.activePositions.get(transaction.txHash);

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

  async updateTokenCurrentPriceToDb(position: TradePositionExtended): Promise<void> {
    try {
      await pool.query(
        `UPDATE trades SET tokendetails = $1 WHERE tokenca = $2;`,
        [position.tokenDetails, position.tokenCA]
      );
    } catch (err) {
      logger.error("❌ Error updating token current price:");
    }
  }

  checkBuyConditions(data: MarketDynamicsApi, tokenName: string) {
    const { marketCap, top10HoldersPercentage, liquidity, holders, holdersSmartMoneyPercent, holdersInfluencersPercent, count5m, volume24h } = data;

    let buyRating: number = 0;
    const violations = [];

    if (parseFloat(holders) >= 300 && parseFloat(holders) <= 4500) {
      buyRating += 1;
    } else {
      violations.push({holders});
    }

    if (parseFloat(top10HoldersPercentage) <= 35) {
      buyRating += 1;
    } else {
      violations.push({top10HoldersPercentage});
    }

    if (parseFloat(liquidity) >= parseFloat(marketCap) * 0.30) {
      buyRating += 1;
    } else {
      violations.push({liquidity});
    }

    if (parseFloat(holdersSmartMoneyPercent) >= 0.1 && parseFloat(holdersSmartMoneyPercent) < 8) {
      buyRating += 1;
    } else {
      violations.push({holdersSmartMoneyPercent});
    }

    if (parseFloat(holdersInfluencersPercent) >= 0.1 && parseFloat(holdersInfluencersPercent) < 8) {
      buyRating += 1;
    } else {
      violations.push({holdersInfluencersPercent});
    }

    if (parseFloat(count5m) >= 150) {
      buyRating += 1;
    } else {
      violations.push({count5m});
    }

    if (parseFloat(volume24h) >= parseFloat(marketCap) * 0.30) {
      buyRating += 1;
    } else {
      violations.push({volume24h});
    }

    if (parseFloat(marketCap) <= 5000000) {
      buyRating += 1;
    } else {
      violations.push({marketCap});
    }

    if (buyRating >= 6) {
      logger.info(`Condition Passed: ${buyRating}, Violations:  ${JSON.stringify(violations)}`)
      return true
    }

    logger.info(`Condition Failed: ${buyRating}, Violations:  ${JSON.stringify(violations)}`)
    return false;
  }

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

  getPosition(entryTxHash: string): TradePositionExtended | undefined {
    return this.activePositions.get(entryTxHash);
  }

  getPositionByTokenCA(tokenCA: string): TradePositionExtended | undefined {
    tokenCA = tokenCA.toLowerCase();

    for (const position of this.activePositions.values()) {
      if (position.tokenCA.toLowerCase() === tokenCA) {
        return position;
      }
    }

    return undefined;
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

}

export default new AnalysisService();
