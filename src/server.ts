import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import monitoringController from './controllers/monitoringController';
import monitoringService from './services/monitoringService';
import logger from './utils/logger';
import tokenController from './controllers/tokenController';
import binanceController from './controllers/binanceController';
import TradeController from './controllers/tradeController';
import walletController from './controllers/walletController';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Crypto Monitoring Bot API',
    version: '1.0.0',
    status: 'active',
    endpoints: {
      binanceAuth: '/api/binance/auth',
      health: '/api/health',
      alerts: '/api/alerts',
      stats: '/api/stats',
      kline: '/api/kline',
      trade: {
        quotes: '/api/trade/quotes',
      },
      token: {
        list: '/api/token/list',
        position: '/api/token/:address/token-position',
        details: '/api/token/:address/details',
        analysis: '/api/token/:address/analysis',
        marketDynamics: '/api/token/:address/market-dynamics',
        tokenIcon: '/api/token-icon',
      },
      buys: {
        trending: '/api/trending',
        smartMoney: '/api/smart-money',
        kol: '/api/kol',
        following: '/api/following'
      },
      socialTweets: '/api/social-tweets',
      tradeStats: '/api/trade-stats/:address',
      positions: {
        active: '/api/positions',
        closed: '/api/closed-positions',
      },
      wallet: {
        walletBalance: '/api/wallet-balance',
        walletTokens: '/api/wallet-tokens/:address/:chain',
      },
      control: {
        start: '/api/monitoring/start',
        stop: '/api/monitoring/stop'
      }
    }
  });
});

// API Routes
app.get('/api/health', (req, res) => {
  res.json({
    uptime: process.uptime(),
    timestamp: Date.now(),
    status: 'ok'
  });
});

//binance services
app.post('/api/binance/auth', binanceController.updateBinanceAuth);
app.get('/api/kline', binanceController.getKlineData);
app.get('/api/trending', binanceController.getTrendingTokens);
app.get('/api/smart-money', binanceController.getSmartMoneyActivity);
app.get('/api/kol', binanceController.getKOLActivity);
app.get('/api/following', binanceController.getFollowingActivity);
app.get('/api/social-tweets', binanceController.getSocialTweets);

//monitoring services
app.get('/api/alerts', monitoringController.getAlerts);
app.get('/api/stats', monitoringController.getStats);
app.get('/api/positions', monitoringController.getActivePositions);
app.get('/api/closed-positions', monitoringController.getClosedPositions);
app.post('/api/monitoring/start', monitoringController.startMonitoring);
app.post('/api/monitoring/stop', monitoringController.stopMonitoring);
app.get('/api/trade-stats/:address', monitoringController.getTradeStats);

//token services
app.get('/api/token/list', tokenController.getTokenList);
app.get('/api/token/:address/token-position', tokenController.getTokenPosition);
app.get('/api/token/:address/details', tokenController.getTokenDetails);
app.get('/api/token/:address/market-dynamics', tokenController.getTokenMarketDynamics);
app.get('/api/token/:address/analysis', tokenController.getTokenAnalysis);
app.get('/api/token-icon', tokenController.getTokenIcon);

//wallet services
app.get('/api/wallet-balance', walletController.getWalletBalance);
app.get('/api/wallet-tokens/:address/:chain', walletController.getWalletTokens);

//trade services
app.get('/api/trade/quotes', TradeController.getTradeQuotes);

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error:');
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

app.use(/.*/, (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start server
const server = app.listen(Number(PORT), '0.0.0.0', () => {
  logger.info(`🌟 Crypto Monitoring Bot API running on port ${PORT}`);
  
  // Start monitoring service
  monitoringService.start();
  
  logger.info('🎯 Bot is now monitoring smart money and KOL transactions 24/7');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  monitoringService.stop();
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  monitoringService.stop();
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

export default app;
