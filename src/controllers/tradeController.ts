import { Request, Response } from 'express';
import { QuoteAggregator } from '../services/quoteAggregatorService';
import logger from '../utils/logger';

export class TradeController {
    private aggregator: QuoteAggregator;

    constructor() {
        this.aggregator = new QuoteAggregator(process.env.ONEINCH_API_KEY);
    }
    
    getTradeQuotes = async (req: Request, res: Response) => {
        try {
            const { src, dst, amount, from } = req.query;

            const result = await this.aggregator.getAllBestQuote({
                sellToken: src as string,
                buyToken: dst as string,
                sellAmount: amount as string,
                taker: from as string,
                slippage: '1',
            });

            if (!result) {
                return res.status(400).json({
                    success: false,
                    error: 'No valid quotes from any provider',
                });
            }

            return res.json({
                success: true,
                data: result,
            });
        } catch (error) {
            logger.error(`TradeController.getTradeQuotes error: ${error}`);
            return res.status(500).json({
                success: false,
                error: 'Internal server error',
            });
        }
    }
    
}

export default new TradeController();