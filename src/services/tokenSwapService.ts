import { Contract, JsonRpcProvider, parseUnits, TransactionReceipt, TransactionRequest, Wallet, MaxUint256 } from "ethers";
import { QuoteAggregator } from "./quoteAggregatorService";
import { SmartMoneyTransaction, TradePositionExtended } from '../types/index';
import logger from "../utils/logger";
import monitoringService from "./monitoringService";
import binanceApi from "./binanceApi";
import analysisService from "./analysisService";
import dbService from "./dbService";

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

    private readonly QUICKNODE_RPC: string = process.env.QUICKNODE_RPC!;
    private readonly LIFI_API_KEY: string = process.env.LIFI_API_KEY!;
    private readonly PRIVATE_KEY: string = process.env.PRIVATE_KEY!;
    private readonly provider = new JsonRpcProvider(this.QUICKNODE_RPC);
    private readonly wallet = new Wallet(this.PRIVATE_KEY, this.provider);
    public readonly walletAddress: string = this.wallet.address;

    // Use token CA to prevent duplicate buys of same token
    private pendingBuyingTokens: Set<string> = new Set();
    private pendingSellingTokens: Set<string> = new Set();

    // Failed transactions queue
    private failedTransactions: Map<string, FailedTransaction> = new Map();
    private readonly MAX_RETRY_ATTEMPTS = 2;
    private readonly RETRY_DELAY_MS = 2000;
    private retryInterval: NodeJS.Timeout | null = null;

    // Trade variables
    private readonly INR_TO_SPEND: number = Number(process.env.INR_TO_SPEND ?? 120);

    private readonly TRADE_THRESHOLDS = {
        BASE_PROFIT_TARGET: 10,
        BASE_PROFIT_TARGET_EXTREME_TOKEN: 7.5
    };

    // Track pre-approved tokens
    private preApprovedTokens: Set<string> = new Set();

    constructor() {
        this.aggregator = new QuoteAggregator(this.LIFI_API_KEY);
        this.startRetryProcessor();
    }

    /**
     * Send transaction without waiting for confirmation
     */
    private async sendTransaction(txRequest: TransactionRequest): Promise<string> {
        const signedTx = await this.wallet.sendTransaction(txRequest);
        return signedTx.hash;
    }

    /**
     * Wait for confirmation and execute callbacks based on result
     */
    private async waitForConfirmationWithCallback(
        hash: string, 
        onSuccess: (receipt: TransactionReceipt) => void | Promise<void>,
        onFailure: (error: Error) => void | Promise<void>,
        timeoutMs = 30_000
    ): Promise<void> {
        try {
            const tx = await this.provider.getTransaction(hash);
            if (!tx) {
                const error = new Error('Transaction not found');
                await onFailure(error);
                return;
            }

            const timeout = new Promise<never>((_, rej) => 
                setTimeout(() => rej(new Error("Transaction timeout")), timeoutMs)
            );

            const receipt = await Promise.race([tx.wait(1), timeout]) as TransactionReceipt;

            if (receipt.status === 0) {
                logger.error(`❌ Tx failed on-chain: ${hash}`);
                await onFailure(new Error('Transaction reverted'));
            } else {
                logger.info(`✅ Tx confirmed: ${hash} (Block: ${receipt.blockNumber})`);
                await onSuccess(receipt);
            }
        } catch (err) {
            logger.error(`❌ Confirmation error: ${hash}`, err instanceof Error ? err.message : String(err));
            await onFailure(err instanceof Error ? err : new Error(String(err)));
        }
    }

    /**
     * Pre-approve token for selling immediately after buy
     */
    private async preApproveTokenForSell(tokenAddress: string, tokenSymbol: string): Promise<void> {
        try {
            if (this.preApprovedTokens.has(tokenAddress.toLowerCase())) {
                logger.info(`✅ ${tokenSymbol} already pre-approved`);
                return;
            }

            const ERC20 = new Contract(tokenAddress, [
                "function approve(address spender, uint256 amount) returns (bool)",
            ], this.wallet);

            // Common router addresses used by LiFi
            const commonRouters = [
                '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', // LiFi Diamond
                '0xD547Eafde2410E63300FC5308CcEa0B356e7B5d8', // Common DEX Router
            ];

            logger.info(`🔓 Pre-approving ${tokenSymbol} for instant sells...`);

            const approvalPromises = commonRouters.map(async (router) => {
                try {
                    const approveTx = await ERC20.approve(router, MaxUint256);
                    logger.info(`⏳ Approval tx sent for ${tokenSymbol} to ${router.slice(0, 8)}...: ${approveTx.hash}`);

                    approveTx.wait(1).then((receipt) => {
                        if (receipt.status === 1) {
                            logger.info(`✅ ${tokenSymbol} pre-approved for ${router.slice(0, 8)}...`);
                        }
                    }).catch(err => {
                        logger.warn(`⚠️ Pre-approval confirmation failed for ${router.slice(0, 8)}...:`, err.message);
                    });
                } catch (error) {
                    logger.warn(`⚠️ Pre-approval failed for router ${router.slice(0, 8)}...:`, error instanceof Error ? error.message : String(error));
                }
            });

            await Promise.allSettled(approvalPromises);
            this.preApprovedTokens.add(tokenAddress.toLowerCase());
            logger.info(`✅ ${tokenSymbol} pre-approval transactions sent`);

        } catch (error) {
            logger.error(`❌ Pre-approval failed for ${tokenSymbol}:`, error instanceof Error ? error.message : String(error));
        }
    }

    private startRetryProcessor() {
        this.retryInterval = setInterval(() => {
            this.processFailedTransactions();
        }, 5000);
    }

    private async processFailedTransactions() {
        const now = Date.now();

        for (const [key, failed] of this.failedTransactions.entries()) {
            if (now - failed.lastAttempt < this.RETRY_DELAY_MS) continue;

            if (failed.attempts >= this.MAX_RETRY_ATTEMPTS) {
                this.failedTransactions.delete(key);
                continue;
            }

            try {
                if (failed.type === 'buy') {
                    await this.executeBuyOrder(failed.transaction as SmartMoneyTransaction, true);
                } else {
                    await this.executeSellOrder(failed.transaction as TradePositionExtended, failed.reason || 'retry', true);
                }

                this.failedTransactions.delete(key);
            } catch (error) {
                failed.attempts++;
                failed.lastAttempt = now;
                failed.lastError = error instanceof Error ? error.message : String(error);
            }
        }
    }

    async executeBuyOrder(transaction: SmartMoneyTransaction, isRetry: boolean = false): Promise<TradePositionExtended | null> {
        const txKey = transaction.txHash;
        const tokenCA = transaction.ca.toLowerCase();

        try {
            // Check if we're already buying this token
            if (!isRetry && this.pendingBuyingTokens.has(tokenCA)) {
                logger.warn(`⚠️ Buy order already pending for token ${transaction.tokenName} (${tokenCA})`);
                return null;
            }

            this.pendingBuyingTokens.add(tokenCA);

            // Parallel fetch of market data and BNB price
            const [currentMarketDynamics, currentBNBPrice] = await Promise.all([
                binanceApi.getTokenMarketDynamics(transaction.ca),
                Promise.resolve(monitoringService.activeWebSockets.get(monitoringService.NATIVE_TOKEN_DATA)?.lastPrice)
            ]);

            const isBuyAllowed = analysisService.checkBuyConditions(currentMarketDynamics, transaction.tokenName);

            if (!isBuyAllowed || Number(transaction.txUsdValue) < 200) {
                this.pendingBuyingTokens.delete(tokenCA);
                return null;
            }

            if (!currentBNBPrice) {
                throw new Error("No BNB price available");
            }

            const bnbToSpend = this.INR_TO_SPEND / (currentBNBPrice * 85);
            const amountInWei = parseUnits(bnbToSpend.toFixed(18), 18);

            logger.info(`💵 Buy ${transaction.tokenName}: ${bnbToSpend.toFixed(6)} BNB`);

            // Get best quote
            const result = await this.aggregator.getBestQuote({
                sellToken: monitoringService.NATIVE_TOKEN_TRADES,
                buyToken: transaction.ca,
                sellAmount: amountInWei.toString(),
                taker: this.walletAddress,
            });

            if (!result) throw new Error("No valid quotes available");

            const txReq = result.bestQuote.quote.transactionRequest;
            if (!txReq.data || txReq.data === '0x') {
                throw new Error('Invalid transaction data from aggregator');
            }

            // Send transaction
            const txHash = await this.sendTransaction(txReq);
            logger.info(`🎉 BUY SENT: ${transaction.tokenName} - ${txHash}`);

            // Prepare token details
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
                entryTxHash: txHash,
                myBuyOrderTx: null,
                tokenDetails: tokenDetails,
                smartMoneyConfirmation: false,
                profitTarget: (marketCap < 100000 || marketCap > 1000000) ? this.TRADE_THRESHOLDS.BASE_PROFIT_TARGET_EXTREME_TOKEN : this.TRADE_THRESHOLDS.BASE_PROFIT_TARGET
            };

            // Wait for confirmation before activating position
            this.waitForConfirmationWithCallback(
                txHash,
                // On Success: Activate position and set everything up
                async (receipt) => {
                    logger.info(`✅ BUY CONFIRMED: ${transaction.tokenName}`);

                    // Update position with receipt
                    position.myBuyOrderTx = JSON.parse(
                        JSON.stringify(receipt, (_key, val) => typeof val === "bigint" ? val.toString() : val)
                    );

                    // NOW activate everything only after confirmation
                    analysisService.activePositions.set(txHash, position);
                    monitoringService.purchasedTokens.add(position.tokenCA.toLowerCase());
                    monitoringService.connectWebSocket(position.tokenCA, position.tokenSymbol);

                    logger.info(
                        `✅ Position activated for ${position.tokenSymbol} ` +
                        `(${monitoringService.activeWebSockets.size}/${monitoringService.MAX_OPEN_POSITIONS})`
                    );

                    // Save to DB
                    await dbService.savePositionToDB(position).catch(err => 
                        logger.error('DB save failed:', err)
                    );

                    // Pre-approve for instant sells
                    this.preApproveTokenForSell(transaction.ca, transaction.tokenName).catch(err => {
                        logger.warn(`⚠️ Pre-approval failed: ${err.message}`);
                    });
                },
                // On Failure: Clean up and don't activate position
                async (error) => {
                    logger.error(`❌ BUY FAILED ON-CHAIN: ${transaction.tokenName} - ${error.message}`);

                    // Clean up - don't activate position
                    this.pendingBuyingTokens.delete(tokenCA);

                    // Log failed transaction for retry if not already retrying
                    if (!isRetry || !this.failedTransactions.has(txKey)) {
                        this.failedTransactions.set(txKey, {
                            transaction,
                            type: 'buy',
                            attempts: isRetry ? 1 : 0,
                            lastError: error.message,
                            lastAttempt: Date.now()
                        });
                        logger.info(`📝 Buy failed, added to retry queue: ${txKey}`);
                    }
                }
            );

            // Release pending lock immediately after sending tx (not after confirmation)
            this.pendingBuyingTokens.delete(tokenCA);

            if (isRetry) this.failedTransactions.delete(txKey);

            // Return position optimistically (will be activated only on confirmation)
            return position;

        } catch (error) {
            this.pendingBuyingTokens.delete(tokenCA);
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`❌ Buy failed: ${errorMessage}`);

            if (!isRetry || !this.failedTransactions.has(txKey)) {
                this.failedTransactions.set(txKey, {
                    transaction,
                    type: 'buy',
                    attempts: isRetry ? 1 : 0,
                    lastError: errorMessage,
                    lastAttempt: Date.now()
                });
            }

            return null;
        }
    }

    async executeSellOrder(position: TradePositionExtended, reason: string, isRetry: boolean = false): Promise<void> {
        const txKey = position.entryTxHash;
        const tokenCA = position.tokenCA.toLowerCase();

        try {
            // Check pending using token CA
            if (!isRetry && this.pendingSellingTokens.has(tokenCA)) {
                logger.warn(`⚠️ Sell order already pending for ${position.tokenSymbol}`);
                return;
            }

            this.pendingSellingTokens.add(tokenCA);

            const taker = this.walletAddress;
            const tokenAddress = position.tokenCA;

            const ERC20 = new Contract(tokenAddress, [
                "function balanceOf(address owner) view returns (uint256)",
                "function allowance(address owner, address spender) view returns (uint256)",
                "function approve(address spender, uint256 amount) returns (bool)",
            ], this.wallet);

            const balance: bigint = await ERC20.balanceOf(taker);

            if (balance === 0n) throw new Error(`No token balance for ${position.tokenSymbol}`);

            // Get quote first
            const result = await this.aggregator.getBestQuote({
                sellToken: tokenAddress,
                buyToken: monitoringService.NATIVE_TOKEN_TRADES,
                sellAmount: balance.toString(),
                taker,
                slippage: "5"
            });

            if (!result) throw new Error("No valid quotes for sell");

            const allowanceTarget = result.bestQuote.allowanceTarget;

            // Check if we need approval
            if (allowanceTarget) {
                const allowance: bigint = await ERC20.allowance(taker, allowanceTarget);

                if (allowance < balance) {
                    logger.warn(`⚠️ ${position.tokenSymbol} not pre-approved, approving now...`);

                    const approveTx = await ERC20.approve(allowanceTarget, MaxUint256);
                    logger.info(`🔓 Approval sent: ${approveTx.hash}`);

                    // Wait 1 second before attempting sell
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else {
                    logger.info(`✅ ${position.tokenSymbol} already approved (instant sell)`);
                }
            }

            const txReq = result.bestQuote.quote.transactionRequest;
            if (!txReq.data || txReq.data === '0x') {
                throw new Error('Invalid transaction data from aggregator');
            }

            // Send transaction
            const txHash = await this.sendTransaction(txReq);
            logger.info(`🎉 SELL SENT: ${position.tokenName} - ${txHash}`);

            // Get market data for record
            const currentMarketPrice = monitoringService.activeWebSockets.get(position.tokenCA);
            const currentPrice = currentMarketPrice?.lastPrice || position.entryPrice;
            const priceChange = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

            const sellRecord = {
                ...position,
                mySellOrderTx: null,
                exitPrice: currentPrice,
                exitMarketCap: 0,
                exitTimestamp: Date.now(),
                priceChangePercent: priceChange,
                marketCapChangePercent: 0,
                holdingDurationMs: Date.now() - position.entryTimestamp,
                exitReason: reason,
                profitLoss: priceChange
            };

            // NEW: Wait for confirmation before cleaning up position
            this.waitForConfirmationWithCallback(
                txHash,
                // On Success: Clean up position
                async (receipt) => {
                    logger.info(`✅ SELL CONFIRMED: ${position.tokenSymbol}`);

                    // Update sell record with receipt
                    sellRecord.mySellOrderTx = JSON.parse(
                        JSON.stringify(receipt, (_key, val) => typeof val === "bigint" ? val.toString() : val)
                    );

                    // Save to DB
                    await dbService.saveSellToDB(sellRecord).catch(err => 
                        logger.error('DB save failed:', err)
                    );

                    // Clean up position
                    analysisService.activePositions.delete(position.entryTxHash);
                    monitoringService.disconnectWebSocket(position.tokenCA);
                    monitoringService.purchasedTokens.delete(position.tokenCA.toLowerCase());
                    this.preApprovedTokens.delete(tokenCA);

                    const profitEmoji = priceChange > 0 ? '📈' : '📉';
                    logger.info(`${profitEmoji} POSITION CLOSED: ${position.tokenSymbol} (${priceChange.toFixed(2)}% P/L) - ${reason}`);
                },
                // On Failure: Keep position active, log error
                async (error) => {
                    logger.error(`❌ SELL FAILED ON-CHAIN: ${position.tokenSymbol} - ${error.message}`);
                    logger.warn(`⚠️ Position remains active, will retry sell`);

                    // Add to retry queue
                    if (!isRetry || !this.failedTransactions.has(txKey)) {
                        this.failedTransactions.set(txKey, {
                            transaction: position,
                            type: 'sell',
                            attempts: isRetry ? 1 : 0,
                            lastError: error.message,
                            lastAttempt: Date.now(),
                            reason
                        });
                    }
                }
            );

            // Release pending lock immediately after sending
            this.pendingSellingTokens.delete(tokenCA);
            if (isRetry) this.failedTransactions.delete(txKey);

        } catch (error) {
            this.pendingSellingTokens.delete(tokenCA);
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`❌ Sell failed: ${errorMessage}`);

            if (!isRetry || !this.failedTransactions.has(txKey)) {
                this.failedTransactions.set(txKey, {
                    transaction: position,
                    type: 'sell',
                    attempts: isRetry ? 1 : 0,
                    lastError: errorMessage,
                    lastAttempt: Date.now(),
                    reason
                });
            }
        }
    }

    public stopRetryProcessor() {
        if (this.retryInterval) {
            clearInterval(this.retryInterval);
            this.retryInterval = null;
        }
    }

    public getFailedTransactionsStatus(): FailedTransaction[] {
        return Array.from(this.failedTransactions.values());
    }

    public isTokenPreApproved(tokenAddress: string): boolean {
        return this.preApprovedTokens.has(tokenAddress.toLowerCase());
    }
}
