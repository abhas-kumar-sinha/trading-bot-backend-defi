import axios, { AxiosInstance } from 'axios';
import { BinanceHeaders, ApiResponse } from '../types/api';
import { SmartMoneyTransaction, TrendingToken, Kline } from '../types/index';
import { generateTraceId } from '../utils/helpers';
import logger from '../utils/logger';
import dotenv from "dotenv";

dotenv.config();

class BinanceApiService {
  private axiosInstance: AxiosInstance;
  private axiosInstancev3: AxiosInstance;
  private axiosInstancev4: AxiosInstance;
  private readonly privateAxiosInstance: AxiosInstance;
  private readonly privateAxiosInstancev2: AxiosInstance;
  private readonly baseHeaders: Partial<BinanceHeaders>;
  private csrfToken: string;
  private cookie: string;

  constructor() {
    this.baseHeaders = {
      'accept': '*/*',
      'accept-language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7,hi;q=0.6,ar;q=0.5',
      'bnc-location': 'IN',
      'bnc-time-zone': 'Asia/Calcutta',
      'bnc-uuid': 'f6892dda-3f11-42a6-9e59-735c22cf68ab',
      'cache-control': 'no-cache',
      'clienttype': 'web',
      'clientversion': '1.0.0',
      'content-type': 'application/json',
      'lang': 'en',
      'origin': 'https://web3.binance.com',
      'pragma': 'no-cache',
      'priority': 'u=1, i',
      'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
      'sec-ch-ua-mobile': '?1',
      'sec-ch-ua-platform': '"Android"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      'x-passthrough-token': '',
    };

    this.csrfToken = process.env.BINANCE_CSRF_TOKEN || '';
    this.cookie = process.env.BINANCE_COOKIE || '';

    this.axiosInstance = axios.create({
      baseURL: 'https://web3.binance.com/bapi/defi/v1/public',
      timeout: 15000,
    });

    this.axiosInstancev3 = axios.create({
      baseURL: 'https://web3.binance.com/bapi/defi/v3/public',
      timeout: 15000,
    });

    this.axiosInstancev4 = axios.create({
      baseURL: 'https://web3.binance.com/bapi/defi/v4/public',
      timeout: 15000,
    });

    this.privateAxiosInstance = axios.create({
      baseURL: 'https://web3.binance.com/bapi/defi/v1/private',
      timeout: 15000,
    });

    this.privateAxiosInstancev2 = axios.create({
      baseURL: 'https://web3.binance.com/bapi/defi/v2/private',
      timeout: 15000,
    });

  }

  private getHeaders(referer: string): BinanceHeaders {
    const traceId = generateTraceId();
    return {
      ...this.baseHeaders,
      'referer': referer,
      'x-trace-id': traceId,
      'x-ui-request-trace': traceId,
      'device-info': 'eyJzY3JlZW5fcmVzb2x1dGlvbiI6IjgwMCwxMjgwIn0=',
      'Cookie': 'bnc-uuid=f6892dda-3f11-42a6-9e59-735c22cf68ab'
    } as BinanceHeaders;
  }

  private getPrivateHeaders(referer: string): BinanceHeaders {
    const traceId = generateTraceId();
    return {
      ...this.baseHeaders,
      'referer': referer,
      'x-trace-id': traceId,
      'x-ui-request-trace': traceId,
      'csrftoken': this.csrfToken,
      'Cookie': this.cookie
    } as BinanceHeaders;
  }

  async updateBinanceAuth(csrfToken: string, cookie: string) {
    this.csrfToken = csrfToken;
    this.cookie = cookie;
  }

  async getSmartMoneyTransactions(): Promise<SmartMoneyTransaction[]> {
    try {
      const response = await this.axiosInstance.post<ApiResponse<SmartMoneyTransaction[]>>(
        '/wallet-direct/tracker/wallet/address/query',
        {
          enableFilterRiskTokens: true,
          chainId: "56",
          tagType: 2
        },
        {
          headers: this.getHeaders('https://web3.binance.com/en/trackers?chain=bsc') as any
        }
      );

      if (response.data.success) {
        logger.info(`Fetched ${response.data.data.length} smart money transactions`);
        return response.data.data;
      }
      return [];
    } catch (error) {
      logger.error('Error fetching smart money transactions:');
      return [];
    }
  }

  async getKOLTransactions(): Promise<SmartMoneyTransaction[]> {
    try {
      const response = await this.axiosInstance.post<ApiResponse<SmartMoneyTransaction[]>>(
        '/wallet-direct/tracker/wallet/address/query',
        {
          enableFilterRiskTokens: true,
          chainId: "56",
          tagType: 1
        },
        {
          headers: this.getHeaders('https://web3.binance.com/en/trackers?chain=bsc') as any
        }
      );

      if (response.data.success) {
        logger.info(`Fetched ${response.data.data.length} KOL transactions`);
        return response.data.data;
      }
      return [];
    } catch (error) {
      logger.error('Error fetching KOL transactions:');
      return [];
    }
  }

  async getFollowingTransactions(): Promise<SmartMoneyTransaction[]> {
    try {
      const response = await this.privateAxiosInstance.post<ApiResponse<SmartMoneyTransaction[]>>(
        '/wallet-direct/tracker/wallet/address/query',
        {
          enableFilterRiskTokens: true,
          chainId: "56",
          groupId: 52064
        },
        {
          headers: this.getPrivateHeaders('https://web3.binance.com/en/trackers?chain=bsc') as any
        }
      );

      if (response.data.success) {
        logger.info(`Fetched ${response.data.data.length} following transactions`);
        return response.data.data;
      }
      return [];
    } catch (error) {
      logger.info('Error fetching following transactions');
      return [];
    }
  }

  async getSocialTweets(): Promise<any> {
    try {
      const response = await this.privateAxiosInstancev2.post<any>(
        '/wallet-direct/tracker/twitter/event/list',
        {
          "translateOn": 1,
          "postEventTypeList": [
            "newTweet",
            "reply",
            "retweet",
            "quote"
          ],
          "caFlag": false,
          "bioFlag": true,
          "followFlag": true,
          "groupIds": [
            "4508"
          ]
        },
        {
          headers: this.getPrivateHeaders('https://web3.binance.com/en/trackers?chain=bsc') as any
        }
      );

      if (response.data.success) {
        logger.info(`Fetched ${response.data.data.length} social tweets`);
        return response.data.data;
      }
      return [];
    } catch (error) {
      logger.info('Error fetching social tweets');
      return [];
    }
  }

  async getTrendingTokens(): Promise<TrendingToken[]> {
    try {
      const response = await this.axiosInstance.post<ApiResponse<{tokens: TrendingToken[]}>>(
        '/wallet-direct/buw/wallet/market/token/pulse/unified/rank/list',
        {
          rankType: 10,
          period: 30,
          chainId: "56",
          liquidityMin: 5000,
          volumeMin: 10000,
          countMin: 10,
          sortBy: 1,
          size: 60,
          uniqueTraderMin: 10
        },
        {
          headers: this.getHeaders('https://web3.binance.com/en/markets/trending?chain=bsc') as any
        }
      );

      if (response.data.success) {
        logger.info(`Fetched ${response.data.data.tokens.length} trending tokens`);
        return response.data.data.tokens;
      }
      return [];
    } catch (error) {
      logger.error('Error fetching trending tokens:');
      return [];
    }
  }

  async getSmartMoneyBuyTokens(): Promise<any[]> {
    try {
      const response = await this.axiosInstance.post<ApiResponse<any[]>>(
        '/wallet-direct/tracker/wallet/token/inflow/rank/query',
        {
          chainId: "56",
          period: "1h",
          tagType: 2
        },
        {
          headers: this.getHeaders('https://web3.binance.com/en/markets/smart-money?chain=bsc') as any
        }
      );

      if (response.data.success) {
        logger.info(`Fetched ${response.data.data.length} smart money buy tokens`);
        return response.data.data;
      }
      return [];
    } catch (error) {
      logger.error('Error fetching smart money buy tokens:');
      return [];
    }
  }

  async getTradeStats(address: string): Promise<any[]> {
    const baseUrl = `/wallet-direct/buw/wallet/address/realized-pnl/list?address=${address}&chainId=56&offset=0`;
    const activeUrl = `/wallet-direct/buw/wallet/address/pnl/active-position-list?address=${address}&chainId=56&offset=0`;
  
    const headers = this.getHeaders('https://web3.binance.com/en/trackers?chain=bsc') as any;
  
    try {
      const [pnlRes, activeRes] = await Promise.all([
        this.axiosInstancev3.get(baseUrl, { headers }),
        this.axiosInstancev3.get(activeUrl, { headers }),
      ]);
  
      const pnlList = pnlRes?.data?.data?.list ?? pnlRes?.data?.data ?? [];
      const activeList = activeRes?.data?.data?.list ?? activeRes?.data?.data ?? [];
  
      const combined = [...pnlList, ...activeList];
  
      logger.info(`Fetched ${combined.length} trade stats for ${address}`);
      return combined;
    } catch (error: any) {
      logger.error(`Error fetching trade stats for ${address}: ${error.message}`);
      return [];
    }
  }
  

  async getTokenDetails(contractAddress: string): Promise<any> {
    try {
      const response = await this.axiosInstance.get(
        `/wallet-direct/buw/wallet/dex/market/token/meta/info?contractAddress=${contractAddress}&chainId=56`,
        {
          headers: this.getHeaders(`https://web3.binance.com/en/token/bsc/${contractAddress}`) as any
        }
      );

      return response.data.data;
    } catch (error) {
      logger.error(`Error fetching token details for ${contractAddress}:`, error);
      return null;
    }
  }

  async getTokenMarketDynamics(contractAddress: string): Promise<any> {
    try {
      const response = await this.axiosInstancev4.get(
        `/wallet-direct/buw/wallet/market/token/dynamic/info?contractAddress=${contractAddress}&chainId=56`,
        {
          headers: this.getHeaders(`https://web3.binance.com/en/token/bsc/${contractAddress}`) as any
        }
      );

      return response.data.data;
    } catch (error) {
      logger.error(`Error fetching token details for ${contractAddress}:`, error);
      return null;
    }
  }

  async getLeaderboard(): Promise<any[]> {
    try {
      const response = await this.axiosInstance.get<ApiResponse<{traders: any[]}>>(
        '/wallet-direct/market/leaderboard/query?tag=ALL&pageNo=1&pageSize=25&sortBy=0&orderBy=0&period=7d&chainId=56',
        {
          headers: this.getHeaders('https://web3.binance.com/en/leaderboard?chain=bsc') as any
        }
      );

      if (response.data.success) {
        return response.data.data.traders || [];
      }
      return [];
    } catch (error) {
      logger.error('Error fetching leaderboard:', error);
      return [];
    }
  }

  async getKlineData(
    interval: string,
    limit: number,
    to: number,
    platform: string,
    address: string
  ): Promise<Kline[]> {
    try {
      const response = await axios.get<Kline[]>(
        `https://dquery.sintral.io/u-kline/v1/k-line/candles?interval=${interval}&limit=${limit}&to=${to}&platform=${platform}&address=${address}`
      );
      return response.data;
    } catch (error) {
      logger.error('Error fetching kline data:', error);
      return [];
    }
  }
}

export default new BinanceApiService();
