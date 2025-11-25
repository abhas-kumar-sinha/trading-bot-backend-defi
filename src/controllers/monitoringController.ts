import { Request, Response } from 'express';
import monitoringService from '../services/monitoringService';
import analysisService from '../services/analysisService';
import binanceApi from '../services/binanceApi';
import logger from '../utils/logger';

export class MonitoringController {
  
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
