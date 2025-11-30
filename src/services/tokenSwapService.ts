import { Contract, JsonRpcProvider, parseUnits, TransactionReceipt, TransactionRequest, Wallet } from "ethers";
import { QuoteAggregator } from "./quoteAggregatorService";
import { SmartMoneyTransaction, TradePositionExtended } from '../types/index';
import logger from "../utils/logger";
import monitoringService from "./monitoringService";
import binanceApi from "./binanceApi";
import analysisService from "./analysisService";
import pool, { initDB } from "../db";

interface FailedTransaction {
    transaction: SmartMoneyTransaction | TradePositionExtended;
    type: 'buy' | 'sell';
    attempts: number;
    lastError: string;
    lastAttempt: number;
    reason?: string;
}

export class TokenSwapService {

    private aggregator: QuoteAggregator;
    private dbInitialized = false;

    private readonly QUICKNODE_RPC: string = process.env.QUICKNODE_RPC!;
    private readonly ONEINCH_API_KEY: string = process.env.ONEINCH_API_KEY!;
    private readonly LIFI_API_KEY: string = process.env.LIFI_API_KEY!;
    private readonly PRIVATE_KEY: string = process.env.PRIVATE_KEY!;
    private readonly provider = new JsonRpcProvider(this.QUICKNODE_RPC);
    private readonly wallet = new Wallet(this.PRIVATE_KEY, this.provider);
    public readonly walletAddress: string = this.wallet.address;

    // Pending Phase
    private pendingBuyingTokens: Set<string> = new Set();
    private pendingSellingTokens: Set<string> = new Set();

    // Failed transactions queue
    private failedTransactions: Map<string, FailedTransaction> = new Map();
    private readonly MAX_RETRY_ATTEMPTS = 3;
    private readonly RETRY_DELAY_MS = 5000;
    private retryInterval: NodeJS.Timeout | null = null;

    // Trade variables
    private readonly INR_TO_SPEND: number = Number(process.env.INR_TO_SPEND ?? 120);

    // Slippage configuration
    private readonly SLIPPAGE_CONFIG = {
        MIN: 1,           // Start with 1%
        MAX: 15,          // Maximum allowed 15%
        INCREMENT: 2,     // Increase by 2% on each retry
        DEFAULT: 5        // Default for first attempt
    };

    private readonly TRADE_THRESHOLDS = {
        BASE_PROFIT_TARGET: 10,
    };

    constructor() {
        this.aggregator = new QuoteAggregator(this.ONEINCH_API_KEY, this.LIFI_API_KEY);
        this.startRetryProcessor();
    }

    private async ensureDBReady() {
        if (!this.dbInitialized) {
            await initDB();
            this.dbInitialized = true;
        }
    }

    private jsonObjectBigIntSafe<T>(value: T): T {
        return JSON.parse(
            JSON.stringify(value, (_key, val) =>
                typeof val === "bigint" ? val.toString() : val
            )
        );
    }

    /**
     * Calculate dynamic slippage based on attempt number and error type
     */
    private calculateSlippage(attempts: number, lastError?: string): number {
        // If last error was slippage-related, be more aggressive
        const isSlippageError = lastError?.toLowerCase().includes('return amount') || 
                               lastError?.toLowerCase().includes('slippage') ||
                               lastError?.toLowerCase().includes('insufficient');
        
        if (attempts === 0) {
            return this.SLIPPAGE_CONFIG.DEFAULT;
        }
        
        const baseIncrease = isSlippageError ? this.SLIPPAGE_CONFIG.INCREMENT * 1.5 : this.SLIPPAGE_CONFIG.INCREMENT;
        const calculatedSlippage = this.SLIPPAGE_CONFIG.DEFAULT + (attempts * baseIncrease);
        
        return Math.min(calculatedSlippage, this.SLIPPAGE_CONFIG.MAX);
    }

    /**
     * Enhanced gas estimation with fallback
     */
    private async estimateGasWithFallback(txRequest: TransactionRequest): Promise<bigint> {
        try {
            const estimated = await this.provider.estimateGas(txRequest);
            // Add 10% buffer for safety
            return (estimated * 110n) / 100n;
        } catch (error) {
            logger.warn(`⚠️ Gas estimation failed, using fallback: ${error}`);
            // Fallback to a reasonable default for swap transactions
            return 500000n;
        }
    }

    /**
     * Get current gas price with buffer
     */
    private async getGasPrice(): Promise<bigint> {
        const feeData = await this.provider.getFeeData();
        const gasPrice = feeData.gasPrice || parseUnits('5', 'gwei');
        
        // Add 10% buffer to gas price
        return (gasPrice * 110n) / 100n;
    }

    /**
     * Send and wait for transaction confirmation with enhanced error handling
     */
    private async sendAndWait(
        txRequest: TransactionRequest, 
        timeoutMs = 60_000,
        attemptNumber = 0
    ): Promise<TransactionReceipt> {
        try {
            // Get fresh gas estimates
            const gasLimit = await this.estimateGasWithFallback(txRequest);
            const gasPrice = await this.getGasPrice();
            
            // Override with calculated values
            txRequest.gasLimit = gasLimit;
            txRequest.gasPrice = gasPrice;
            
            logger.info(`📡 Submitting tx (attempt ${attemptNumber + 1}) - Gas: ${gasLimit}, Price: ${gasPrice}`);

            const signedTx = await this.wallet.sendTransaction(txRequest);
            const hash = signedTx.hash;
            logger.info(`📡 Broadcasted tx ${hash}`);
            
            const timeout = new Promise<never>((_, rej) => 
                setTimeout(() => rej(new Error("Transaction timeout")), timeoutMs)
            );
            
            const receipt = await Promise.race([signedTx.wait(1), timeout]) as TransactionReceipt;
            
            if (receipt.status === 0) {
                throw new Error('Transaction reverted on-chain');
            }
            
            logger.info(`✅ Tx confirmed: ${hash} (Block: ${receipt.blockNumber})`);
            return receipt;
        } catch (err) {
            const error = err as Error;
            logger.error(`❌ Tx failed:`, error.message);
            throw error;
        }
    }

    private startRetryProcessor() {
        this.retryInterval = setInterval(() => {
            this.processFailedTransactions();
        }, 10000);
    }

    private async processFailedTransactions() {
        const now = Date.now();
        
        for (const [key, failed] of this.failedTransactions.entries()) {
            if (now - failed.lastAttempt < this.RETRY_DELAY_MS) {
                continue;
            }

            if (failed.attempts >= this.MAX_RETRY_ATTEMPTS) {
                logger.error(`❌ Max retry attempts reached for ${key}`);
                this.failedTransactions.delete(key);
                continue;
            }

            logger.info(`🔄 Retrying ${failed.type} for ${key} (${failed.attempts + 1}/${this.MAX_RETRY_ATTEMPTS})`);
            
            try {
                if (failed.type === 'buy') {
                    await this.executeBuyOrder(failed.transaction as SmartMoneyTransaction, true);
                } else {
                    await this.executeSellOrder(failed.transaction as TradePositionExtended, failed.reason || 'retry', true);
                }
                
                this.failedTransactions.delete(key);
                logger.info(`✅ Retry successful for ${key}`);
            } catch (error) {
                failed.attempts++;
                failed.lastAttempt = now;
                failed.lastError = error instanceof Error ? error.message : String(error);
                logger.warn(`⚠️ Retry failed for ${key}: ${failed.lastError}`);
            }
        }
    }

    async executeBuyOrder(transaction: SmartMoneyTransaction, isRetry: boolean = false): Promise<TradePositionExtended | null> {
        const txKey = transaction.txHash;
        const currentMarketDynamics = await binanceApi.getTokenMarketDynamics(transaction.ca);

        const isBuyAllowed = analysisService.checkBuyConditions(currentMarketDynamics, transaction.tokenName);
        
        try {

            if (!isBuyAllowed || Number(transaction.txUsdValue) < 420) {
                logger.warn(`⚠️ Buy not allowed for ${txKey}`);
                return null;
            }

            if (!isRetry && this.pendingBuyingTokens.has(txKey)) {
                logger.warn(`⚠️ Buy order already pending for ${txKey}`);
                return null;
            }

            this.pendingBuyingTokens.add(txKey);

            const currentBNBPrice = monitoringService.activeWebSockets.get(
                monitoringService.NATIVE_TOKEN_DATA
            )?.lastPrice;

            if (!currentBNBPrice) {
                throw new Error("No BNB price available");
            }

            const bnbToSpend = this.INR_TO_SPEND / (currentBNBPrice * 85);
            const amountInWei = parseUnits(bnbToSpend.toFixed(18), 18);

            // Calculate dynamic slippage
            const failed = this.failedTransactions.get(txKey);
            const attempts = failed?.attempts || 0;
            const slippage = this.calculateSlippage(attempts, failed?.lastError);
            
            logger.info(`💵 Spending ${bnbToSpend.toFixed(6)} BNB (~₹${this.INR_TO_SPEND}) for ${transaction.tokenName} (Slippage: ${slippage}%)`);

            // Get best quote with dynamic slippage
            const result = await this.aggregator.getBestQuote({
                sellToken: monitoringService.NATIVE_TOKEN_TRADES,
                buyToken: transaction.ca,
                sellAmount: amountInWei.toString(),
                taker: this.walletAddress,
                slippage: slippage.toString(),
            });

            if (!result) {
                throw new Error("No valid quotes available");
            }

            logger.info(`✅ Best quote from ${result.bestQuote.provider} - Expected tokens: ${result.bestQuote.quote}`);

            const txReq = await this.aggregator.buildTxFromQuote(
                result.bestQuote.quote,
                result.bestQuote.provider
            );

            // Validate transaction has data
            if (!txReq.data || txReq.data === '0x') {
                throw new Error('Invalid transaction data from aggregator');
            }

            // Validate quote is still fresh (within 30 seconds)
            const quoteAge = Date.now() - (result.bestQuote.quote.timestamp || Date.now());
            if (quoteAge > 30000) {
                logger.warn(`⚠️ Quote is ${quoteAge}ms old, refreshing...`);
                throw new Error('Quote too old, retry needed');
            }

            // Send transaction with enhanced gas handling
            const receipt = await this.sendAndWait(txReq, 60_000, attempts);

            logger.info(`🎉 BUY EXECUTED: ${transaction.tokenName} - ${receipt.hash}`);

            // Fetch market data
            const marketCap = parseFloat(currentMarketDynamics.marketCap);
            const price = parseFloat(currentMarketDynamics.price);
            const timestamp = Date.now();

            const tokenDetails = {
                contractAddress: transaction.ca,
                symbol: transaction.tokenName,
                name: transaction.tokenName,
                marketCap: marketCap,
                price: price,
                count5m: parseFloat(currentMarketDynamics.count5m),
                priceChange24h: parseFloat(currentMarketDynamics.percentChange24h),
                launchTime: parseFloat(currentMarketDynamics.launchTime),
                liquidity: parseFloat(currentMarketDynamics.liquidity),
                holders: parseFloat(currentMarketDynamics.holders),
                kycHolderCount: parseFloat(currentMarketDynamics.kycHolderCount),
                top10HoldersPercentage: parseFloat(currentMarketDynamics.top10HoldersPercentage),
                holdersSmartMoneyPercent: parseFloat(currentMarketDynamics.holdersSmartMoneyPercent),
                holdersInfluencersPercent: parseFloat(currentMarketDynamics.holdersInfluencersPercent),
                tokenHigh: 0,
                tokenLow: 0,
                currentChange: 0,
                changeTime: Math.floor(Date.now() / 1000)
            };

            const position: TradePositionExtended = {
                tokenCA: transaction.ca,
                tokenSymbol: transaction.tokenName,
                tokenName: transaction.tokenName,
                walletAddress: transaction.address,
                entryPrice: price,
                entryMarketCap: marketCap,
                entryTimestamp: timestamp,
                entryTxHash: receipt.hash,
                myBuyOrderTx: this.jsonObjectBigIntSafe(receipt),
                tokenDetails: tokenDetails,
                smartMoneyConfirmation: false,
                profitTarget: this.TRADE_THRESHOLDS.BASE_PROFIT_TARGET
            };

            analysisService.activePositions.set(receipt.hash, position);
            await this.savePositionToDB(position);

            logger.info(`💰 POSITION OPENED: ${position.tokenSymbol} at $${price} (MC: $${marketCap.toLocaleString()})`);
            
            this.pendingBuyingTokens.delete(txKey);
            
            if (isRetry) {
                this.failedTransactions.delete(txKey);
            }
            
            return position;

        } catch (error) {
            this.pendingBuyingTokens.delete(txKey);
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`❌ Buy failed for ${transaction.tokenName}: ${errorMessage}`);

            // Check if error is retryable
            const isRetryable = 
                errorMessage.includes('Return amount is not enough') ||
                errorMessage.includes('Quote too old') ||
                errorMessage.includes('Gas estimation failed') ||
                errorMessage.includes('timeout');

            if (isRetryable && (!isRetry || !this.failedTransactions.has(txKey))) {
                const currentFailed = this.failedTransactions.get(txKey);
                this.failedTransactions.set(txKey, {
                    transaction,
                    type: 'buy',
                    attempts: currentFailed ? currentFailed.attempts + 1 : (isRetry ? 1 : 0),
                    lastError: errorMessage,
                    lastAttempt: Date.now()
                });
                logger.info(`📝 Added to retry queue: ${txKey} (attempts: ${this.failedTransactions.get(txKey)!.attempts})`);
            } else if (!isRetryable) {
                logger.error(`❌ Non-retryable error, skipping: ${errorMessage}`);
            }

            return null;
        }
    }
        
    async executeSellOrder(position: TradePositionExtended, reason: string, isRetry: boolean = false): Promise<void> {
        const txKey = position.entryTxHash;
        
        try {
            if (!isRetry && this.pendingSellingTokens.has(txKey)) {
                logger.warn(`⚠️ Sell order already pending for ${txKey}`);
                return;
            }

            this.pendingSellingTokens.add(txKey);

            const taker = this.walletAddress;
            const tokenAddress = position.tokenCA;

            const ERC20 = new Contract(tokenAddress, [
                "function balanceOf(address owner) view returns (uint256)",
                "function allowance(address owner, address spender) view returns (uint256)",
                "function approve(address spender, uint256 amount) returns (bool)",
            ], this.wallet);

            const balance: bigint = await ERC20.balanceOf(taker);
            
            if (balance === 0n) {
                throw new Error(`No token balance for ${position.tokenSymbol}`);
            }

            logger.info(`💼 Token balance: ${balance.toString()} ${position.tokenSymbol}`);

            // Calculate dynamic slippage
            const failed = this.failedTransactions.get(txKey);
            const attempts = failed?.attempts || 0;
            const slippage = this.calculateSlippage(attempts, failed?.lastError);
            
            logger.info(`💰 Selling with ${slippage}% slippage tolerance`);

            const result = await this.aggregator.getBestQuote({
                sellToken: tokenAddress,
                buyToken: monitoringService.NATIVE_TOKEN_TRADES,
                sellAmount: balance.toString(),
                taker,
                slippage: slippage.toString(),
            });

            if (!result) {
                throw new Error("No valid quotes for sell");
            }

            // Perform approval if needed
            const allowanceTarget = result.bestQuote.allowanceTarget;
            if (allowanceTarget) {
                const allowance: bigint = await ERC20.allowance(taker, allowanceTarget);

                if (allowance < balance) {
                    logger.info(`🔓 Approving ${result.bestQuote.provider} to spend tokens`);
                    
                    // Get gas price for approval
                    const gasPrice = await this.getGasPrice();
                    
                    const approveTx = await ERC20.approve(allowanceTarget, balance, {
                        gasPrice: gasPrice,
                        gasLimit: 100000n // Standard approval gas limit
                    });
                    
                    logger.info(`⏳ Approval tx sent: ${approveTx.hash}`);
                    const approvalReceipt = await approveTx.wait(1);
                    
                    if (approvalReceipt.status === 0) {
                        throw new Error('Approval transaction failed');
                    }
                    
                    logger.info(`✅ Approval confirmed`);
                } else {
                    logger.debug(`✅ Sufficient allowance already present`);
                }
            }

            logger.info(`✅ Best quote from ${result.bestQuote.provider} - Expected BNB: ${result.bestQuote.quote}`);

            const txReq = await this.aggregator.buildTxFromQuote(
                result.bestQuote.quote,
                result.bestQuote.provider
            );

            // Validate transaction has data
            if (!txReq.data || txReq.data === '0x') {
                throw new Error('Invalid transaction data from aggregator');
            }

            // Validate quote freshness
            const quoteAge = Date.now() - (result.bestQuote.quote.timestamp || Date.now());
            if (quoteAge > 30000) {
                logger.warn(`⚠️ Quote is ${quoteAge}ms old, refreshing...`);
                throw new Error('Quote too old, retry needed');
            }

            // Send transaction with enhanced gas handling
            const receipt = await this.sendAndWait(txReq, 60_000, attempts);

            logger.info(`🎉 SELL EXECUTED: ${position.tokenName} - ${receipt.hash}`);

            // Get final market data
            const currentMarketPrice = monitoringService.activeWebSockets.get(position.tokenCA);
            const currentMarketDynamics = await binanceApi.getTokenMarketDynamics(position.tokenCA);
            const totalSupply = parseFloat(currentMarketDynamics.totalSupply || "0");
            const circulatingSupply = parseFloat(currentMarketDynamics.circulatingSupply || "0");
            const currentPrice = currentMarketPrice?.lastPrice || parseFloat(currentMarketDynamics.price);

            const supplyToUse = circulatingSupply < totalSupply ? circulatingSupply : totalSupply;
            const currentMarketCap = currentPrice * supplyToUse;
            const priceChange = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
            const mcChange = ((currentMarketCap - position.entryMarketCap) / position.entryMarketCap) * 100;
            const timestamp = Date.now();
            const holdingDuration = timestamp - position.entryTimestamp;

            const sellRecord = {
                ...position,
                mySellOrderTx: this.jsonObjectBigIntSafe(receipt),
                exitPrice: currentPrice,
                exitMarketCap: currentMarketCap,
                exitTimestamp: timestamp,
                priceChangePercent: priceChange,
                marketCapChangePercent: mcChange,
                holdingDurationMs: holdingDuration,
                exitReason: reason,
                profitLoss: priceChange
            };

            await this.saveSellToDB(sellRecord);

            analysisService.activePositions.delete(position.entryTxHash);
            monitoringService.disconnectWebSocket(position.tokenCA);
            monitoringService.purchasedTokens.delete(position.tokenCA.toLowerCase());

            const profitEmoji = priceChange > 0 ? '📈' : '📉';
            logger.info(`${profitEmoji} POSITION CLOSED: ${position.tokenSymbol} at $${currentPrice.toFixed(8)} (${priceChange.toFixed(2)}% P/L) - ${reason}`);
            
            this.pendingSellingTokens.delete(txKey);
            
            if (isRetry) {
                this.failedTransactions.delete(txKey);
            }

        } catch (error) {
            this.pendingSellingTokens.delete(txKey);
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`❌ Sell failed for ${position.tokenName}: ${errorMessage}`);

            // Check if error is retryable
            const isRetryable = 
                errorMessage.includes('Return amount is not enough') ||
                errorMessage.includes('Quote too old') ||
                errorMessage.includes('Gas estimation failed') ||
                errorMessage.includes('timeout');

            if (isRetryable && (!isRetry || !this.failedTransactions.has(txKey))) {
                const currentFailed = this.failedTransactions.get(txKey);
                this.failedTransactions.set(txKey, {
                    transaction: position,
                    type: 'sell',
                    attempts: currentFailed ? currentFailed.attempts + 1 : (isRetry ? 1 : 0),
                    lastError: errorMessage,
                    lastAttempt: Date.now(),
                    reason
                });
                logger.info(`📝 Added to retry queue: ${txKey} (attempts: ${this.failedTransactions.get(txKey)!.attempts})`);
            } else if (!isRetryable) {
                logger.error(`❌ Non-retryable error, skipping: ${errorMessage}`);
            }
        }
    }

    private async savePositionToDB(position: TradePositionExtended): Promise<void> {
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

    private async saveSellToDB(sellRecord: TradePositionExtended): Promise<void> {
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

    public stopRetryProcessor() {
        if (this.retryInterval) {
            clearInterval(this.retryInterval);
            this.retryInterval = null;
            logger.info('🛑 Retry processor stopped');
        }
    }

    public getFailedTransactionsStatus(): FailedTransaction[] {
        return Array.from(this.failedTransactions.values());
    }
}
