import { Request, Response } from 'express';
import logger from '../utils/logger';
import analysisService from '../services/analysisService';
import walletService from '../services/walletService';

export class WalletController {

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

    async getWalletTokens(req: Request, res: Response) {
        try {
            const { address, chain } = req.params;
            
            if (!address) {
                return res.status(400).json({
                success: false,
                error: 'Token address is required'
                });
            }

            const walletTokens = await walletService.getWalletTokens(address, chain);
            
            res.json({
                success: true,
                count: walletTokens.length,
                data: walletTokens
            });
        } catch (error) {
            logger.error('Error getting wallet tokens:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch wallet tokens'
            });
        }
    }
}

export default new WalletController();