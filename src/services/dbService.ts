import pool, { initDB } from "../db";
import { TradePositionExtended } from '../types/index';
import logger from "../utils/logger";

export class DBService {

    private dbInitialized = false;

    private async ensureDBReady() {
        if (!this.dbInitialized) {
            await initDB();
            this.dbInitialized = true;
        }
    }

    public async savePositionToDB(position: TradePositionExtended): Promise<void> {
        try {
            await this.ensureDBReady();
            await pool.query(
                `INSERT INTO trades (
                    tokenCA, tokenSymbol, tokenName, walletAddress, entryPrice, entryMarketCap,
                    entryTimestamp, entryTxHash, tokenDetails, myBuyOrderTx, smartMoneyConfirmation, profitTarget
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                ON CONFLICT (entryTxHash) DO NOTHING;`,
                [
                    position.tokenCA,
                    position.tokenSymbol,
                    position.tokenName,
                    position.walletAddress,
                    position.entryPrice,
                    position.entryMarketCap,
                    position.entryTimestamp,
                    position.entryTxHash,
                    JSON.stringify(position.tokenDetails),
                    JSON.stringify(position.myBuyOrderTx),
                    position.smartMoneyConfirmation,
                    position.profitTarget,
                ]
            );

            logger.info(`💾 Position saved to DB: ${position.tokenSymbol}`);
        } catch (err) {
            logger.error(`❌ Error saving position to DB: ${err}`);
            throw err;
        }
    }

    public async saveSellToDB(sellRecord: TradePositionExtended): Promise<void> {
        try {
            await this.ensureDBReady();
            const res = await pool.query(
                `UPDATE trades
                SET
                    tokenDetails = $1,
                    mySellOrderTx = $2,
                    exitPrice = $3,
                    exitMarketCap = $4,
                    exitTimestamp = $5,
                    priceChangePercent = $6,
                    marketCapChangePercent = $7,
                    holdingDurationMs = $8,
                    exitReason = $9,
                    profitLoss = $10
                WHERE entryTxHash = $11
                AND exitTimestamp IS NULL
                RETURNING tokenSymbol;`,
                [
                    JSON.stringify(sellRecord.tokenDetails),
                    JSON.stringify(sellRecord.mySellOrderTx),
                    sellRecord.exitPrice ?? null,
                    sellRecord.exitMarketCap ?? null,
                    sellRecord.exitTimestamp ?? null,
                    sellRecord.priceChangePercent ?? null,
                    sellRecord.marketCapChangePercent ?? null,
                    sellRecord.holdingDurationMs ?? null,
                    sellRecord.exitReason ?? null,
                    sellRecord.profitLoss ?? null,
                    sellRecord.entryTxHash,
                ]
            );

            if (res.rowCount === 0) {
                logger.warn(`⚠️ No matching trade found for entryTxHash: ${sellRecord.entryTxHash}`);
            } else {
                logger.info(`💾 Sell record saved to DB: ${res.rows[0].tokensymbol}`);
            }
        } catch (err) {
            logger.error(`❌ Error updating sell record in DB: ${err}`);
            throw err;
        }
    }
    
}

export default new DBService();