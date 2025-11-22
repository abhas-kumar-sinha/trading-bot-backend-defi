import express from 'express';
import cors from 'cors';
import crypto from "crypto";
import { exec } from "child_process";
import dotenv from 'dotenv';
import monitoringController from './controllers/monitoringController';
import monitoringService from './services/monitoringService';
import logger from './utils/logger';

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
      token: {
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
        closed: '/api/closed-positions'
      },
      walletBalance: '/api/wallet-balance',
      webhook: '/github/webhook',
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

//Github Automation
app.post("/github/webhook", (req, res) => {
  const sig = req.headers["x-hub-signature-256"];
  const hmac = crypto.createHmac("sha256", SECRET);
  const digest = "sha256=" + hmac.update(JSON.stringify(req.body)).digest("hex");

  if (sig !== digest) {
    return res.status(401).send("Invalid signature");
  }

  exec("/home/aks_freelance12/deploy.sh", (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ Deployment error: ${error.message}`);
      return res.status(500).send("Deployment failed");
    }
    logger.info(`✅ Deployment output:\n${stdout}`);
    res.status(200).send("Deployed successfully");
  });
});

app.post('/api/binance/auth', monitoringController.updateBinanceAuth);
app.get('/api/alerts', monitoringController.getAlerts);
app.get('/api/stats', monitoringController.getStats);
app.get('/api/kline', monitoringController.getKlineData);
app.get('/api/token/:address/details', monitoringController.getTokenDetails);
app.get('/api/token/:address/market-dynamics', monitoringController.getTokenMarketDynamics);
app.get('/api/token/:address/analysis', monitoringController.getTokenAnalysis);
app.get('/api/token-icon', monitoringController.getTokenIcon);
app.get('/api/trending', monitoringController.getTrendingTokens);
app.get('/api/smart-money', monitoringController.getSmartMoneyActivity);
app.get('/api/kol', monitoringController.getKOLActivity);
app.get('/api/following', monitoringController.getFollowingActivity);
app.get('/api/social-tweets', monitoringController.getSocialTweets);
app.get('/api/trade-stats/:address', monitoringController.getTradeStats);
app.get('/api/positions', monitoringController.getActivePositions);
app.get('/api/closed-positions', monitoringController.getClosedPositions);
app.get('/api/wallet-balance', monitoringController.getWalletBalance);
app.post('/api/monitoring/start', monitoringController.startMonitoring);
app.post('/api/monitoring/stop', monitoringController.stopMonitoring);

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
