import { Request, Response } from 'express';
import monitoringService from '../services/monitoringService';
import analysisService from '../services/analysisService';
import binanceApi from '../services/binanceApi';
import { formatedInterval } from '../utils/helpers';
import logger from '../utils/logger';
import axios from 'axios';
import openOceanApi from '../services/openOceanApi';

export class MonitoringController {

  async updateBinanceAuth(req: Request, res: Response) {
    try {
      const { csrfToken, cookie } = req.body;
      if (!csrfToken || !cookie) {
        return res.status(400).json({
          success: false,
          error: 'CSRF token and cookie are required'
        });
      }
      await binanceApi.updateBinanceAuth(csrfToken, cookie);
      res.json({
        success: true,
        message: 'Binance auth updated successfully'
      });
    } catch (error) {
      logger.error('Error updating binance auth:');
      res.status(500).json({
        success: false,
        error: 'Failed to update binance auth'
      });
    }
  }

  async getTokenIcon(req: Request, res: Response) {
    try {
      const { url } = req.query;
      if (!url) {
        return res.status(400).send('Token icon URL is required');
      }
  
      // Prepend base URL if relative
      const fullUrl = url.toString().startsWith('http')
        ? url.toString()
        : `https://bin.bnbstatic.com/${url}`;
  
      const r = await axios.get(fullUrl, { responseType: 'arraybuffer' });
  
      res.setHeader('Content-Type', 'image/png');
      res.send(r.data);
    } catch (error) {
      console.error('Error getting token icon:', error);
      res.status(500).send('Error fetching token icon');
    }
  }
  

  async getAlerts(req: Request, res: Response) {
    try {
      const { count = 50, priority } = req.query;
      const alerts = monitoringService.getRecentAlerts(
        parseInt(count as string),
        priority as string
      );

      res.json({
        success: true,
        count: alerts.length,
        data: alerts
      });
    } catch (error) {
      logger.error('Error getting alerts:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch alerts'
      });
    }
  }

  async getStats(req: Request, res: Response) {
    try {
      const stats = monitoringService.getStats();
      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('Error getting stats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch stats'
      });
    }
  }

  async getKlineData(req: Request, res: Response) {
    try {
      const { interval = '1h', limit = 100, to, platform = 'binance', address } = req.query;

      if (!address) {
        return res.status(400).json({
          success: false,
          error: 'Address parameter is required'
        });
      }

      const formattedInterval = formatedInterval(interval as string);
      const timestamp = to ? parseInt(to as string) : Date.now();

      const klines = await binanceApi.getKlineData(
        formattedInterval,
        parseInt(limit as string),
        timestamp,
        platform as string,
        address as string
      );

      res.json({
        success: true,
        data: klines
      });
    } catch (error) {
      logger.error('Error getting kline data:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch kline data'
      });
    }
  }

  async getTokenList(req: Request, res: Response) {
    try {
      const tokenList = await openOceanApi.getTokenList();
      res.json({
        success: true,
        data: tokenList
      });
    } catch (error) {
      logger.error('Error getting token list:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch token list'
      });
    }
  }

  async getTokenPosition(req: Request, res: Response) {
    try {
      const { address } = req.params;
      
      if (!address) {
        return res.status(400).json({
          success: false,
          error: 'Token address is required'
        });
      }

      const tokenPosition = await analysisService.getTokenPosition(address);
      res.json({
        success: true,
        data: tokenPosition
      });
    } catch (error) {
      logger.error('Error getting token position:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch token position'
      });
    }
  }

  async getTokenDetails(req: Request, res: Response) {
    try {
      const { address } = req.params;
      
      if (!address) {
        return res.status(400).json({
          success: false,
          error: 'Token address is required'
        });
      }

      const tokenDetails = await binanceApi.getTokenDetails(address);
      res.json({
        success: true,
        data: tokenDetails
      });
    } catch (error) {
      logger.error('Error getting token details:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch token details'
      });
    }
  }

  async getTokenMarketDynamics(req: Request, res: Response) {
    try {
      const { address } = req.params;
      
      if (!address) {
        return res.status(400).json({
          success: false,
          error: 'Token address is required'
        });
      }

      const tokenDetails = await binanceApi.getTokenMarketDynamics(address);
      res.json({
        success: true,
        data: tokenDetails
      });
    } catch (error) {
      logger.error('Error getting token details:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch token details'
      });
    }
  }

  async getTokenAnalysis(req: Request, res: Response) {
    try {
      const { address } = req.params;
      
      if (!address) {
        return res.status(400).json({
          success: false,
          error: 'Token address is required'
        });
      }

      const cachedData = monitoringService.getCachedData();
      const analysis = analysisService.generateTokenAnalysis(
        address,
        cachedData.smartMoney,
        cachedData.kol,
        cachedData.following,
        cachedData.trending
      );

      if (!analysis) {
        return res.status(404).json({
          success: false,
          error: 'No analysis data available for this token'
        });
      }

      res.json({
        success: true,
        data: analysis
      });
    } catch (error) {
      logger.error('Error getting token analysis:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to analyze token'
      });
    }
  }

  async getTrendingTokens(req: Request, res: Response) {
    try {
      const trendingTokens = await binanceApi.getTrendingTokens();
      res.json({
        success: true,
        count: trendingTokens.length,
        data: trendingTokens
      });
    } catch (error) {
      logger.error('Error getting trending tokens:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch trending tokens'
      });
    }
  }

  async getSmartMoneyActivity(req: Request, res: Response) {
    try {
      const cachedData = monitoringService.getCachedData();
      res.json({
        success: true,
        count: cachedData.smartMoney.length,
        data: cachedData.smartMoney.slice(0, 40) // Return latest 40
      });
    } catch (error) {
      logger.error('Error getting smart money activity:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch smart money activity'
      });
    }
  }

  async getKOLActivity(req: Request, res: Response) {
    try {
      const cachedData = monitoringService.getCachedData();
      res.json({
        success: true,
        count: cachedData.kol.length,
        data: cachedData.kol.slice(0, 40) // Return latest 40
      });
    } catch (error) {
      logger.error('Error getting KOL activity:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch KOL activity'
      });
    }
  }

  async getFollowingActivity(req: Request, res: Response) {
    try {
      const cachedData = monitoringService.getCachedData();
      res.json({
        success: true,
        count: cachedData.following.length,
        data: cachedData.following.slice(0, 40) // Return latest 40
      });
    } catch (error) {
      logger.error('Error getting following activity:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch following activity'
      });
    }
  }

  async getSocialTweets(req: Request, res: Response) {
    try {
      const socialTweets = await binanceApi.getSocialTweets();
      res.json({
        success: true,
        count: socialTweets.length,
        data: socialTweets.slice(0, 40) // Return latest 40
      });
    } catch (error) {
      logger.error('Error getting social tweets:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch social tweets'
      });
    }
  }

  async getTradeStats(req: Request, res: Response) {
    try {
      const tradeStats = await binanceApi.getTradeStats(req.params.address);
      res.json({
        success: true,
        count: tradeStats.length,
        data: tradeStats.slice(0, 40) // Return latest 40
      });
    } catch (error) {
      logger.error('Error getting trade stats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch trade stats'
      });
    }
  }

  getActivePositions(req: Request, res: Response) {
    try {
      const positions = analysisService.getActivePositions();
      res.json({
        success: true,
        count: positions.length,
        data: positions
      });
    } catch (error) {
      logger.error('Error getting active positions:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch active positions'
      });
    }
  }

  async getClosedPositions(req: Request, res: Response) {
    try {
      const positions = await analysisService.getClosedPositions();
      res.json({
        success: true,
        count: positions.length,
        data: positions
      });
    } catch (error) {
      logger.error('Error getting closed positions:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch closed positions'
      });
    }
  }

  async getWalletBalance(req: Request, res: Response) {
    try {
      const walletBalance = await analysisService.getWalletBalance();
      res.json({
        success: true,
        count: walletBalance.length,
        data: walletBalance
      });
    } catch (error) {
      logger.error('Error getting wallet balance:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch wallet balance'
      });
    }
  }

  async startMonitoring(req: Request, res: Response) {
    try {
      monitoringService.start();
      res.json({
        success: true,
        message: 'Monitoring service started'
      });
    } catch (error) {
      logger.error('Error starting monitoring:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to start monitoring service'
      });
    }
  }

  async stopMonitoring(req: Request, res: Response) {
    try {
      monitoringService.stop();
      res.json({
        success: true,
        message: 'Monitoring service stopped'
      });
    } catch (error) {
      logger.error('Error stopping monitoring:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to stop monitoring service'
      });
    }
  }
}

export default new MonitoringController();
