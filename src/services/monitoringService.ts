import cron from 'node-cron';
import WebSocket from 'ws';
import binanceApi from './binanceApi';
import analysisService from './analysisService';
import { MonitoringAlert, SmartMoneyTransaction, TrendingToken } from '../types/index';
import logger from '../utils/logger';

interface WebSocketConnection {
  ws: WebSocket;
  tokenCA: string;
  tokenSymbol: string;
  lastPrice: number | null;
  reconnectAttempts: number;
}

class MonitoringService {
  private alerts: MonitoringAlert[] = [];
  private isRunning: boolean = false;
  private lastFetchTime: number = 0;
  private readonly MAX_ALERTS = 1000;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY = 5000;
  private readonly MAX_OPEN_POSITIONS = 5; // Maximum number of concurrent positions
  private readonly STOP_LOSS_PERCENTAGE = -20; // Stop loss at -20%
  private readonly SMART_STOP_LOSS_PERCENTAGE = -40; // Smart money stop loss at -40%
  public readonly NATIVE_TOKEN: string = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  
  private smartMoneyData: SmartMoneyTransaction[] = [];
  private kolData: SmartMoneyTransaction[] = [];
  private followingData: SmartMoneyTransaction[] = [];
  private trendingData: TrendingToken[] = [];
  private processedTxHashes: Set<string> = new Set();
  
  // Track tokens we've already bought (to prevent duplicate buys)
  private purchasedTokens: Set<string> = new Set();
  
  // WebSocket connections for active positions
  public activeWebSockets: Map<string, WebSocketConnection> = new Map();
  private readonly SINTRAL_WS_URL = process.env.SINTRAL_WS_URL || 'wss://nbstream.binance.com/w3w/stream';
  private readonly KLINE_INTERVAL = '1s';

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Monitoring service is already running');
      return;
    }

    this.isRunning = true;
    logger.info('🚀 Starting crypto monitoring service with WebSocket price tracking...');

    // Ensure positions are synced from DB and populate purchasedTokens set
    await analysisService.ensurePositionDbSync();
    const activePositions = analysisService.getActivePositions();
    
    for (const position of activePositions) {
      this.purchasedTokens.add(position.tokenCA.toLowerCase());
      
      // Only connect WebSocket if we're under the limit
      if (this.activeWebSockets.size < this.MAX_OPEN_POSITIONS) {
        this.connectWebSocket(position.tokenCA, position.tokenSymbol);
      }
    }

    logger.info(`📊 Loaded ${activePositions.length} existing positions from DB`);

    // BNB websocket connection
    this.connectWebSocket(this.NATIVE_TOKEN, "BNB");
    //wait to get bnb price
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Immediate first fetch
    this.performMonitoringCycle();

    // Immediate position monitor
    this.monitorPositions()

    // Primary monitoring: Following wallets every 2 second
    cron.schedule('*/2 * * * * *', () => {
      if (this.isRunning) {
        this.monitorFollowingWallets();
      }
    });

    // Secondary monitoring: Smart money and KOL every 5 seconds
    cron.schedule('*/5 * * * * *', () => {
      if (this.isRunning) {
        this.monitorSmartMoneyAndKOL();
      }
    });

    //Position monitoring every 10 minutes
    cron.schedule('*/10 * * * *', () => {
      if (this.isRunning) {
        this.monitorPositions();
      }
    });

    // Update trending tokens every 5 minutes
    cron.schedule('*/5 * * * *', () => {
      if (this.isRunning) {
        this.updateTrendingTokens();
      }
    });

    // Cleanup every hour
    cron.schedule('0 * * * *', () => {
      this.cleanupOldAlerts();
      this.cleanupProcessedHashes();
    });

    logger.info('✅ Monitoring service started successfully');
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    
    // Close all WebSocket connections
    this.activeWebSockets.forEach((conn) => {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close();
      }
    });
    this.activeWebSockets.clear();
    
    logger.info('🛑 Monitoring service stopped');
  }

  /**
   * Primary monitoring: Following wallets (every 1 second)
   */
  private async monitorFollowingWallets(): Promise<void> {
    try {
      const followingTxs = await binanceApi.getFollowingTransactions();
      this.followingData = followingTxs;

      for (const transaction of followingTxs.slice(0, 10)) {
        if (this.processedTxHashes.has(transaction.txHash)) {
          continue;
        }

        const alert = analysisService.analyzeFollowingTransaction(transaction);
        
        if (alert) {
          this.addAlert(alert);
          this.processedTxHashes.add(transaction.txHash);

          // Execute buy order and start WebSocket monitoring
          if (alert.type === 'FOLLOWING_BUY') {
            const tokenCALower = transaction.ca.toLowerCase();
            
            // Check if we already have a position for this token
            if (this.purchasedTokens.has(tokenCALower)) {
              logger.info(
                `⚠️ Skipping duplicate buy for ${transaction.tokenName} - position already exists`
              );
              continue;
            }
            
            // Check if we've reached the maximum number of positions
            if (this.activeWebSockets.size >= this.MAX_OPEN_POSITIONS) {
              logger.warn(
                `⚠️ Max positions reached (${this.MAX_OPEN_POSITIONS}), skipping buy for ${transaction.tokenName}`
              );
              continue;
            }
            
            const position = await analysisService.executeBuyOrder(transaction);
            if (position) {
              this.purchasedTokens.add(tokenCALower);
              this.connectWebSocket(position.tokenCA, position.tokenSymbol);
              
              logger.info(
                `✅ New position opened for ${position.tokenSymbol} ` +
                `(${this.activeWebSockets.size}/${this.MAX_OPEN_POSITIONS})`
              );
            }
          }
          // Execute sell order and close WebSocket
          else if (alert.type === 'FOLLOWING_SELL') {
            const position = analysisService.getPosition(transaction.ca);
            if (position) {
              await analysisService.executeSellOrder(
                position,
                'WALLET_SOLD'
              );
              this.disconnectWebSocket(transaction.ca);
              this.purchasedTokens.delete(transaction.ca.toLowerCase());
            }
          }
        }
      }
    } catch (error) {
      logger.error('❌ Error monitoring following wallets:');
    }
  }

  /**
   * Connect WebSocket for real-time price updates
   */
  private connectWebSocket(tokenCA: string, tokenSymbol: string): void {
    const lowerCA = tokenCA.toLowerCase();
    
    // Check if already connected
    if (this.activeWebSockets.has(lowerCA)) {
      logger.warn(`WebSocket already connected for ${tokenSymbol}`);
      return;
    }

    // Check position limit
    if (this.activeWebSockets.size >= this.MAX_OPEN_POSITIONS) {
      logger.warn(
        `Cannot connect WebSocket for ${tokenSymbol} - max positions (${this.MAX_OPEN_POSITIONS}) reached`
      );
      return;
    }

    logger.info(`🔌 Connecting WebSocket for ${tokenSymbol} (${tokenCA})`);

    const ws = new WebSocket(this.SINTRAL_WS_URL);
    
    const connection: WebSocketConnection = {
      ws,
      tokenCA,
      tokenSymbol,
      lastPrice: null,
      reconnectAttempts: 0
    };

    
    this.activeWebSockets.set(lowerCA, connection);
    
    ws.on('open', () => {
      logger.info(`✅ WebSocket connected for ${tokenSymbol}`);
      
      // Send Get_property
      ws.send(JSON.stringify({
        id: 1,
        method: 'GET_PROPERTY',
        params: ["combined"]
      }));

      // Subscribe to kline data
      ws.send(JSON.stringify({
        id: 2,
        method: 'SUBSCRIBE',
        params: [`kl@14@${tokenCA === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" ? "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c" : tokenCA}@${this.KLINE_INTERVAL}`]
      }));

      connection.reconnectAttempts = 0;
    });

    ws.on('message', async (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // Handle kline updates
        if (msg.d && msg.d.u) {
          const klineData = msg.d.u;
          await this.handleKlineUpdate(connection, klineData);
        }
      } catch (error) {
        logger.error(`Error processing WebSocket message for ${tokenSymbol}:`, error);
      }
    });

    ws.on('error', (error) => {
      logger.error(`WebSocket error for ${tokenSymbol}:`, error);
    });

    ws.on('close', () => {
      logger.warn(`🔌 WebSocket closed for ${tokenSymbol}`);
      
      // Attempt reconnection if position is still active
      if (this.isRunning && analysisService.getPosition(tokenCA)) {
        this.handleReconnection(connection);
      } else {
        this.activeWebSockets.delete(lowerCA);
      }
    });
  }

  /**
   * Handle kline data updates from WebSocket
   */
  private async handleKlineUpdate(connection: WebSocketConnection, klineData: any): Promise<void> {
    try {
      // Kline data format: [open, high, low, close, volume, timestamp]
      const currentPrice = parseFloat(klineData[3]); // close price
      
      // Update last price regardless of change magnitude for accurate tracking
      connection.lastPrice = currentPrice;

      // BNB price update
      if (connection.tokenCA === this.NATIVE_TOKEN) {
        return;
      }

      // Get the active position
      const position = analysisService.getPosition(connection.tokenCA);
      if (!position) {
        logger.warn(`No active position found for ${connection.tokenSymbol}, closing WebSocket`);
        this.disconnectWebSocket(connection.tokenCA);
        this.purchasedTokens.delete(connection.tokenCA.toLowerCase());
        return;
      }
      // Calculate profit/loss percentage
      const profitPercentage = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

      if (position.tokenDetails) {        
        // Update high and low
        if (profitPercentage > position.tokenDetails.tokenHigh) {
          position.tokenDetails.tokenHigh = profitPercentage;
        }
        if (profitPercentage < position.tokenDetails.tokenLow) {
          position.tokenDetails.tokenLow = profitPercentage;
        }
      }

      // Estimate market cap based on price change
      const priceChangeRatio = currentPrice / position.entryPrice;
      const estimatedMarketCap = position.entryMarketCap * priceChangeRatio;

      // Check for stop loss (-20%)
      if (((profitPercentage <= this.STOP_LOSS_PERCENTAGE) && !position.smartMoneyConfirmation) || ((profitPercentage <= this.SMART_STOP_LOSS_PERCENTAGE) && position.smartMoneyConfirmation)) {
        logger.warn(
          `🛑 STOP LOSS triggered for ${connection.tokenSymbol}: ${profitPercentage.toFixed(2)}%`
        );
        
        await analysisService.executeSellOrder(
          position,
          'STOP_LOSS'
        );

        const alert: MonitoringAlert = {
          type: 'SELL_EXECUTED',
          timestamp: Date.now(),
          data: {
            tokenCA: position.tokenCA,
            tokenSymbol: position.tokenSymbol,
            reason: 'STOP_LOSS',
            price: currentPrice,
            marketCap: estimatedMarketCap,
            profitPercentage: profitPercentage
          },
          priority: 'HIGH',
          message: `🛑 STOP LOSS: ${position.tokenSymbol} at $${currentPrice.toFixed(8)} (${profitPercentage.toFixed(2)}%)`
        };
        this.addAlert(alert);

        this.disconnectWebSocket(connection.tokenCA);
        this.purchasedTokens.delete(connection.tokenCA.toLowerCase());
        return;
      }

      // Check profit target sell conditions
      const sellCheck = await analysisService.checkSellConditions(
        position,
        currentPrice,
        estimatedMarketCap
      );

      if (sellCheck?.shouldSell) {
        logger.info(
          `🎯 Profit target met for ${connection.tokenSymbol}: ${profitPercentage.toFixed(2)}% - ${sellCheck.reason}`
        );
        
        await analysisService.executeSellOrder(
          position,
          sellCheck.reason
        );

        const alert: MonitoringAlert = {
          type: 'SELL_EXECUTED',
          timestamp: Date.now(),
          data: {
            tokenCA: position.tokenCA,
            tokenSymbol: position.tokenSymbol,
            reason: sellCheck.reason,
            price: currentPrice,
            marketCap: estimatedMarketCap,
            profitPercentage: profitPercentage
          },
          priority: 'HIGH',
          message: `💸 SELL: ${position.tokenSymbol} at $${currentPrice.toFixed(8)} (+${profitPercentage.toFixed(2)}%) - ${sellCheck.reason}`
        };
        this.addAlert(alert);

        this.disconnectWebSocket(connection.tokenCA);
        this.purchasedTokens.delete(connection.tokenCA.toLowerCase());
      } else {
        // Log current position status (only if price changed significantly)
        if (connection.lastPrice !== null) {
          const priceChange = Math.abs((currentPrice - connection.lastPrice) / connection.lastPrice * 100);
          if (priceChange >= 0.5) { // Log every 0.5% change
            logger.debug(
              `📊 ${connection.tokenSymbol}: $${currentPrice.toFixed(8)} ` +
              `(${profitPercentage > 0 ? '+' : ''}${profitPercentage.toFixed(2)}%) ` +
              `Target: ${position.profitTarget}% | Stop Loss: ${this.STOP_LOSS_PERCENTAGE}%`
            );
          }
        }
      }
    } catch (error) {
      logger.error(`Error handling kline update for ${connection.tokenSymbol}:`, error);
    }
  }

  /**
   * Disconnect WebSocket for a specific token
   */
  private disconnectWebSocket(tokenCA: string): void {
    const lowerCA = tokenCA.toLowerCase();
    const connection = this.activeWebSockets.get(lowerCA);
    
    if (connection) {
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.close();
      }
      this.activeWebSockets.delete(lowerCA);
      logger.info(
        `🔌 WebSocket disconnected for ${connection.tokenSymbol} ` +
        `(${this.activeWebSockets.size}/${this.MAX_OPEN_POSITIONS})`
      );
    }
  }

  /**
   * Handle WebSocket reconnection with exponential backoff
   */
  private handleReconnection(connection: WebSocketConnection): void {
    // Don't reconnect if we're at max positions
    if (this.activeWebSockets.size >= this.MAX_OPEN_POSITIONS) {
      logger.warn(
        `❌ Cannot reconnect ${connection.tokenSymbol} - max positions reached`
      );
      this.activeWebSockets.delete(connection.tokenCA.toLowerCase());
      return;
    }

    if (connection.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        `❌ Max reconnection attempts reached for ${connection.tokenSymbol}, giving up`
      );
      this.activeWebSockets.delete(connection.tokenCA.toLowerCase());
      return;
    }

    connection.reconnectAttempts++;
    const delay = this.RECONNECT_DELAY * Math.pow(2, connection.reconnectAttempts - 1);
    
    logger.info(
      `🔄 Reconnecting WebSocket for ${connection.tokenSymbol} ` +
      `(attempt ${connection.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}) ` +
      `in ${delay}ms`
    );

    setTimeout(() => {
      this.activeWebSockets.delete(connection.tokenCA.toLowerCase());
      this.connectWebSocket(connection.tokenCA, connection.tokenSymbol);
    }, delay);
  }

  /**
   * Secondary monitoring: Smart money and KOL for confirmation (every 5 seconds)
   */
  private async monitorSmartMoneyAndKOL(): Promise<void> {
    try {
      const [smartMoneyTxs, kolTxs, followingTxs] = await Promise.all([
        binanceApi.getSmartMoneyTransactions(),
        binanceApi.getKOLTransactions(),
        binanceApi.getFollowingTransactions()
      ]);

      this.smartMoneyData = smartMoneyTxs;
      this.kolData = kolTxs;

      for (const transaction of smartMoneyTxs.slice(0, 10)) {
        analysisService.analyzeSmartMoneyForConfirmation(transaction, 'SMART_MONEY');
      }

      for (const transaction of kolTxs.slice(0, 10)) {
        analysisService.analyzeSmartMoneyForConfirmation(transaction, 'KOL');
      }

      for (const transaction of followingTxs.slice(0, 10)) {
        analysisService.analyzeSmartMoneyForConfirmation(transaction, 'FOLLOWING');
      }

    } catch (error) {
      logger.error('❌ Error monitoring smart money/KOL/Following:', error);
    }
  }

  private async performMonitoringCycle(): Promise<void> {
    await this.monitorFollowingWallets();
    await this.monitorSmartMoneyAndKOL();
  }

  private monitorPositions(): void {
    try {
      const positions = analysisService.getActivePositions();
      for (const position of positions) {
        analysisService.monitorPosition(position);
      }
    } catch (error) {
      logger.error('Error monitoring positions:', error);
    }
  }

  private async updateTrendingTokens(): Promise<void> {
    try {
      const trendingTokens = await binanceApi.getTrendingTokens();
      this.trendingData = trendingTokens;
      analysisService.updateTrendingCache(trendingTokens);
    } catch (error) {
      logger.error('Error updating trending tokens:', error);
    }
  }

  private addAlert(alert: MonitoringAlert): void {
    this.alerts.unshift(alert);
    
    if (this.alerts.length > this.MAX_ALERTS) {
      this.alerts = this.alerts.slice(0, this.MAX_ALERTS);
    }

    if (alert.type === 'FOLLOWING_BUY' || alert.type === 'FOLLOWING_SELL' || alert.type === 'SELL_EXECUTED') {
      logger.warn(`🎯 ${alert.message}`);
    }
  }

  private cleanupOldAlerts(): void {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    const initialCount = this.alerts.length;
    
    this.alerts = this.alerts.filter(alert => alert.timestamp > oneHourAgo);
    
    const removedCount = initialCount - this.alerts.length;
    if (removedCount > 0) {
      logger.info(`🧹 Cleaned up ${removedCount} old alerts`);
    }
  }

  private cleanupProcessedHashes(): void {
    if (this.processedTxHashes.size > 10000) {
      const hashesArray = Array.from(this.processedTxHashes);
      this.processedTxHashes = new Set(hashesArray.slice(-5000));
      logger.info('🧹 Cleaned up processed transaction hashes');
    }
  }

  getRecentAlerts(count: number = 50, priority?: string): MonitoringAlert[] {
    let filteredAlerts = this.alerts;
    
    if (priority) {
      filteredAlerts = this.alerts.filter(alert => alert.priority === priority.toUpperCase());
    }
    
    return filteredAlerts.slice(0, count);
  }

  getStats() {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    const recentAlerts = this.alerts.filter(alert => alert.timestamp > oneHourAgo);
    const priorities = recentAlerts.reduce((acc, alert) => {
      acc[alert.priority] = (acc[alert.priority] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const activePositions = analysisService.getActivePositions();
    const activeWebSocketCount = this.activeWebSockets.size;

    return {
      totalAlerts: this.alerts.length,
      recentAlerts: recentAlerts.length,
      priorityBreakdown: priorities,
      isRunning: this.isRunning,
      lastFetchTime: new Date(this.lastFetchTime).toISOString(),
      smartMoneyTransactions: this.smartMoneyData.length,
      kolTransactions: this.kolData.length,
      followingTransactions: this.followingData.length,
      trendingTokens: this.trendingData.length,
      activePositions: activePositions.length,
      activeWebSockets: activeWebSocketCount,
      maxPositions: this.MAX_OPEN_POSITIONS,
      stopLossPercentage: this.STOP_LOSS_PERCENTAGE,
      positions: activePositions.map(p => {
        const conn = this.activeWebSockets.get(p.tokenCA.toLowerCase());
        const profitPercentage = conn?.lastPrice 
          ? ((conn.lastPrice - p.entryPrice) / p.entryPrice) * 100 
          : null;
        
        return {
          token: p.tokenSymbol,
          entryPrice: p.entryPrice,
          currentPrice: conn?.lastPrice || null,
          profitPercentage: profitPercentage,
          profitTarget: p.profitTarget,
          smartMoneyConfirmed: p.smartMoneyConfirmation,
          hasWebSocket: this.activeWebSockets.has(p.tokenCA.toLowerCase())
        };
      }),
      webSocketStatus: Array.from(this.activeWebSockets.values()).map(conn => ({
        token: conn.tokenSymbol,
        connected: conn.ws.readyState === WebSocket.OPEN,
        lastPrice: conn.lastPrice,
        reconnectAttempts: conn.reconnectAttempts
      }))
    };
  }

  getCachedData() {
    return {
      smartMoney: this.smartMoneyData,
      kol: this.kolData,
      following: this.followingData,
      trending: this.trendingData,
      activePositions: analysisService.getActivePositions()
    };
  }
}

export default new MonitoringService();