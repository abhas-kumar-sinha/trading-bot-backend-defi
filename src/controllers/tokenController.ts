import { Request, Response } from 'express';
import monitoringService from '../services/monitoringService';
import analysisService from '../services/analysisService';
import binanceApi from '../services/binanceApi';
import logger from '../utils/logger';
import openOceanApi from '../services/openOceanApi';
import axios from 'axios';

export class TokenController {

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
}

export default new TokenController()