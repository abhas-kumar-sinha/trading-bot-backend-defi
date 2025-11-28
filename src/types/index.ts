export interface MarketDynamicsApi {
  marketCap: string;
  price: string;
  top10HoldersPercentage: string;
  count5m: string;
  percentChange24h: string;
  launchTime: string;
  liquidity: string;
  holders: string;
  kycHolderCount: string;
  holdersSmartMoneyPercent: string;
  holdersInfluencersPercent: string;
  totalSupply: string;
  circulatingSupply: string;
  volume24h: string;
}

export interface Kline {
    timestamp: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
}

export interface SmartMoneyTransaction {
  chainId: string;
  txHash: string;
  address: string;
  label: string | null;
  ts: number;
  tradeSideCategory: number;
  txUsdValue: string;
  nativePrice: string;
  tokenSupply: string;
  tokenPrice: string;
  txNativeTokenQty: string;
  ca: string;
  tokenIconUrl: string;
  tokenName: string;
  tokenDecimals: number;
  marketCap: string;
  tokenRiskLevel: number;
  addressLogoUrl: string | null;
  launchTime: number | null;
}

export interface TrendingToken {
  chainId: string;
  contractAddress: string;
  symbol: string;
  icon: string;
  price: string;
  percentChange24h: string;
  volume24h: string;
  marketCap: string;
  holders: string;
  liquidity: string;
  auditInfo: {
    riskLevel: number;
    riskCodes: string[];
    riskNum: number;
    cautionNum: number;
  };
  metaInfo: {
    name: string;
    decimals: number;
  };
}

export interface MonitoringAlert {
  type: 'SMART_MONEY' | 'KOL' | 'TRENDING_MATCH' | 'HIGH_VOLUME' | 'FOLLOWING_BUY' | 'FOLLOWING_SELL' | 'FOLLOWING' | 'SELL_EXECUTED';
  timestamp: number;
  data: any;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  message: string;
}

export interface TradePosition {
  tokenCA: string;
  tokenSymbol: string;
  tokenName: string;
  walletAddress: string;
  entryPrice: number;
  entryMarketCap: number;
  entryTimestamp: number;
  entryTxHash: string;
  myBuyOrderTx: any;
  tokenDetails: any;
  smartMoneyConfirmation: boolean;
  profitTarget: number;
  mySellOrderTx?: any;
  exitPrice?: number;
  exitMarketCap?: number;
  exitTimestamp?: number;
  priceChangePercent?: number;
  marketCapChangePercent?: number;
  holdingDurationMs?: number;
  exitReason?: string;
  profitLoss?: number;
}

export interface TradePositionExtended extends TradePosition {
  smartMoneyConfirmation: boolean;
  profitTarget: number; // 10% or 15%
}

export interface TokenAnalysis {
  contractAddress: string;
  symbol: string;
  name: string;
  isTrending: boolean;
  riskLevel: number;
  smartMoneyActivity: number;
  kolActivity: number;
  followingActivity: number;
  priceChange24h: number;
  volume24h: number;
  marketCap: number;
  recommendation: 'BUY' | 'HOLD' | 'SELL' | 'AVOID';
  confidence: number;
}
  