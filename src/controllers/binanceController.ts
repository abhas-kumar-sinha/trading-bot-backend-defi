import { Request, Response } from 'express';
import monitoringService from '../services/monitoringService';
import binanceApi from '../services/binanceApi';
import analysisService from '../services/analysisService';
import { formatedInterval } from '../utils/helpers';
import logger from '../utils/logger';

export class BinanceController {
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
        data: cachedData.following.filter((item) => parseFloat(item.marketCap) >= 10000).slice(0, 40)
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
    
}

export default new BinanceController();