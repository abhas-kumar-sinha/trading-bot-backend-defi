import { Pool } from "pg";
import dotenv from "dotenv";
import logger from "./utils/logger";

dotenv.config();

const pool = new Pool({
  connectionString: process.env.NEON_DB_URL,
});

export const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      tokenCA TEXT,
      tokenSymbol TEXT,
      tokenName TEXT,
      walletAddress TEXT,
      entryPrice DOUBLE PRECISION,
      entryMarketCap DOUBLE PRECISION,
      entryTimestamp BIGINT,
      entryTxHash TEXT UNIQUE,
      tokenDetails JSONB,
      myBuyOrderTx JSONB,
      smartMoneyConfirmation BOOLEAN,
      profitTarget DOUBLE PRECISION,
      mySellOrderTx JSONB,
      exitPrice DOUBLE PRECISION,
      exitMarketCap DOUBLE PRECISION,
      exitTimestamp BIGINT,
      priceChangePercent DOUBLE PRECISION,
      marketCapChangePercent DOUBLE PRECISION,
      holdingDurationMs BIGINT,
      exitReason TEXT,
      profitLoss DOUBLE PRECISION
    );
  `);
  logger.info("✅ NeonDB initialized");
};

export default pool;
