import { Contract, JsonRpcProvider, parseUnits, TransactionReceipt, TransactionRequest, Wallet } from "ethers";
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

    // Pending Phase
    private pendingBuyingTokens: Set<string> = new Set();
    private pendingSellingTokens: Set<string> = new Set();

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

    constructor() {
        this.aggregator = new QuoteAggregator(this.LIFI_API_KEY);
        this.startRetryProcessor();
    }


    /**
     * Send transaction without waiting for confirmation
     * Returns hash immediately for faster execution
     */
    private async sendTransaction(txRequest: TransactionRequest): Promise<string> {
        const signedTx = await this.wallet.sendTransaction(txRequest);
        return signedTx.hash;
    }

    /**
     * Optional confirmation check (run async in background)
     */
    private async waitForConfirmation(hash: string, timeoutMs = 30_000): Promise<void> {
        try {
            const tx = await this.provider.getTransaction(hash);
            if (!tx) throw new Error('Transaction not found');

            const timeout = new Promise<never>((_, rej) => 
                setTimeout(() => rej(new Error("Confirmation timeout")), timeoutMs)
            );

            const receipt = await Promise.race([tx.wait(1), timeout]) as TransactionReceipt;

            if (receipt.status === 0) {
                logger.error(`❌ Tx failed: ${hash}`);
            }
        } catch (err) {
            logger.error(`❌ Confirmation failed: ${hash}`);
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

        try {
            if (!isRetry && this.pendingBuyingTokens.has(txKey)) return null;
            this.pendingBuyingTokens.add(txKey);

            const [currentMarketDynamics, currentBNBPrice] = await Promise.all([
                binanceApi.getTokenMarketDynamics(transaction.ca),
                Promise.resolve(monitoringService.activeWebSockets.get(monitoringService.NATIVE_TOKEN_DATA)?.lastPrice)
            ]);

            const isBuyAllowed = analysisService.checkBuyConditions(currentMarketDynamics, transaction.tokenName);

            if (!isBuyAllowed || Number(transaction.txUsdValue) < 400) {
                this.pendingBuyingTokens.delete(txKey);
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

            const txHash = await this.sendTransaction(txReq);
            logger.info(`🎉 BUY SENT: ${transaction.tokenName} - ${txHash}`);

            this.waitForConfirmation(txHash, 30_000);

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

            analysisService.activePositions.set(txHash, position);

            dbService.savePositionToDB(position).catch(err => logger.error('DB save failed:', err));

            this.pendingBuyingTokens.delete(txKey);
            monitoringService.purchasedTokens.add(position.tokenCA.toLowerCase());
            monitoringService.connectWebSocket(position.tokenCA, position.tokenSymbol);

            if (isRetry) this.failedTransactions.delete(txKey);

            return position;

        } catch (error) {
            this.pendingBuyingTokens.delete(txKey);
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

        try {
            if (!isRetry && this.pendingSellingTokens.has(txKey)) return;
            this.pendingSellingTokens.add(txKey);

            const taker = this.walletAddress;
            const tokenAddress = position.tokenCA;

            const ERC20 = new Contract(tokenAddress, [
                "function balanceOf(address owner) view returns (uint256)",
                "function allowance(address owner, address spender) view returns (uint256)",
                "function approve(address spender, uint256 amount) returns (bool)",
            ], this.wallet);

            const balance: bigint = await ERC20.balanceOf(taker);

            if (balance === 0n) throw new Error(`No token balance for ${position.tokenSymbol}`);

            const result = await this.aggregator.getBestQuote({
                sellToken: tokenAddress,
                buyToken: monitoringService.NATIVE_TOKEN_TRADES,
                sellAmount: balance.toString(),
                taker,
                slippage: "5",
            });

            if (!result) throw new Error("No valid quotes for sell");

            const allowanceTarget = result.bestQuote.allowanceTarget;
            if (allowanceTarget) {
                const allowance: bigint = await ERC20.allowance(taker, allowanceTarget);

                if (allowance < balance) {
                    const approveTx = await ERC20.approve(allowanceTarget, balance);
                    logger.info(`🔓 Approval sent: ${approveTx.hash}`);

                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            const txReq = result.bestQuote.quote.transactionRequest;
            if (!txReq.data || txReq.data === '0x') {
                throw new Error('Invalid transaction data from aggregator');
            }

            const txHash = await this.sendTransaction(txReq);
            logger.info(`🎉 SELL SENT: ${position.tokenName} - ${txHash}`);

            this.waitForConfirmation(txHash, 30_000);

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

            dbService.saveSellToDB(sellRecord).catch(err => logger.error('DB save failed:', err));

            analysisService.activePositions.delete(position.entryTxHash);
            monitoringService.disconnectWebSocket(position.tokenCA);
            monitoringService.purchasedTokens.delete(position.tokenCA.toLowerCase());

            const profitEmoji = priceChange > 0 ? '📈' : '📉';
            logger.info(`${profitEmoji} SOLD: ${position.tokenSymbol} (${priceChange.toFixed(2)}% P/L) - ${reason}`);

            this.pendingSellingTokens.delete(txKey);
            if (isRetry) this.failedTransactions.delete(txKey);

        } catch (error) {
            this.pendingSellingTokens.delete(txKey);
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
}
