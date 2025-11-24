import axios, { AxiosInstance } from "axios";

export interface OpenOceanApiOptions {
  /** e.g. "bsc", "eth", "base", "arbitrum" */
  chain: string;
  /** EVM chain id, e.g. 56 for BSC, 1 for ETH, 8453 for Base */
  chainId: number;
  /** override base URL if needed (default: mainnet API) */
  baseURL?: string;
}

export interface QuoteParams {
  inTokenAddress: string;
  outTokenAddress: string;
  /** amount in smallest units (already *10^decimals) */
  amountDecimals: string;
  /** gas price in smallest units (wei) */
  gasPriceDecimals: string;
  /** slippage %, e.g. 1 = 1% (OpenOcean uses this convention) */
  slippage?: number;
  /** optional account (receiver) */
  account?: string;
  /** optional referrer */
  referrer?: string;
}

export interface ReverseQuoteParams {
  inTokenAddress: string;
  outTokenAddress: string;
  /** human amount (NOT with decimals) */
  amount: string;
  gasPriceDecimals: string;
}

export interface SwapParams {
  inTokenAddress: string;
  outTokenAddress: string;
  /** address receiving tokens */
  account: string;
  /** address paying gas / sending tx */
  sender: string;
  /** input amount in smallest units */
  amountDecimals: string;
  gasPriceDecimals: string;
  /** slippage %, e.g. 1 = 1% */
  slippage?: number;
  /** exact-out mode: pass target outAmountDecimals (optional) */
  outAmountDecimals?: string;
  /** optional referrer */
  referrer?: string;
}

export interface GaslessQuoteParams {
  inTokenAddress: string;
  outTokenAddress: string;
  /** input amount in smallest units */
  amountDecimals: string;
  gasPriceDecimals: string;
  /** 0–100; if undefined, backend defaults to 1% */
  slippage?: number;
  /** user/bot wallet address */
  account: string;
  /** optional referrer */
  referrer?: string;
}

export interface GaslessSwapBody {
  from: string;
  to: string;
  data: string;
  amountDecimals: string;
  feeAmount1: string;
  feeAmount2: string;
  flag: number;
  gasPriceDecimals: string;
  deadline: number;
  inToken: string;
  outToken: string;
  nonce: number;
  permit: string;
  hash?: string;
  usdValuation?: number;
  minOutAmount?: string;
}

class OpenOceanApi {
  private client: AxiosInstance;
  public readonly chain: string;
  public readonly chainId: number;

  constructor(opts: OpenOceanApiOptions) {
    this.chain = opts.chain;
    this.chainId = opts.chainId;

    this.client = axios.create({
      baseURL: opts.baseURL ?? "https://open-api.openocean.finance/v4",
      timeout: 10_000,
    });
  }

  // ---------- Utils ----------

  /** convert human amount -> smallest units (as string) */
  toDecimals(amount: string | number, decimals: number): string {
    const [intPart, fracPart = ""] = String(amount).split(".");
    const cleanFrac = fracPart.padEnd(decimals, "0").slice(0, decimals);
    return `${intPart}${cleanFrac}`.replace(/^0+(?=\d)/, "") || "0";
  }

  /** convert smallest units -> human string */
  fromDecimals(amountDecimals: string, decimals: number): string {
    const neg = amountDecimals.startsWith("-");
    const raw = neg ? amountDecimals.slice(1) : amountDecimals;
    const padded = raw.padStart(decimals + 1, "0");
    const intPart = padded.slice(0, -decimals) || "0";
    let fracPart = padded.slice(-decimals);
    fracPart = fracPart.replace(/0+$/, "");
    const res = fracPart ? `${intPart}.${fracPart}` : intPart;
    return neg ? `-${res}` : res;
  }

  // ---------- Data / info endpoints ----------

  /** GET /v4/:chain/tokenList – list of tokens on this chain */
  async getTokenList() {
    const { data } = await this.client.get(`/${this.chain}/tokenList`);
    if (data?.code !== 200) {
      throw new Error(`tokenList failed: ${data?.msg || "unknown error"}`);
    }
    return data.data as any[];
  }

  /** GET /v4/:chain/gasPrice – latest gasPriceDecimals */
  async getGasPrice() {
    const { data } = await this.client.get(`/${this.chain}/gasPrice`);
    if (data?.code !== 200) {
      throw new Error(`gasPrice failed: ${data?.msg || "unknown error"}`);
    }
    // data.data.gasPriceDecimals or similar, depending on chain
    return data.data;
  }

  // ---------- Quote endpoints ----------

  /**
   * Normal quote – GET /v4/:chain/quote
   * amountDecimals & gasPriceDecimals are already in smallest units.
   */
  async getQuote(params: QuoteParams) {
    const query: Record<string, string | number> = {
      inTokenAddress: params.inTokenAddress,
      outTokenAddress: params.outTokenAddress,
      amountDecimals: params.amountDecimals,
      gasPriceDecimals: params.gasPriceDecimals,
    };

    if (params.slippage !== undefined) query.slippage = params.slippage;
    if (params.account) query.account = params.account;
    if (params.referrer) query.referrer = params.referrer;

    const { data } = await this.client.get(`/${this.chain}/quote`, {
      params: query,
    });

    if (data?.code !== 200) {
      throw new Error(`quote failed: ${data?.msg || "unknown error"}`);
    }
    return data.data;
  }

  /**
   * Reverse quote – GET /v4/:chain/reverseQuote
   * exact-out: pass human "amount" of desired output token.
   */
  async getReverseQuote(params: ReverseQuoteParams) {
    const query = {
      inTokenAddress: params.inTokenAddress,
      outTokenAddress: params.outTokenAddress,
      amount: params.amount,
      gasPrice: params.gasPriceDecimals,
    };

    const { data } = await this.client.get(`/${this.chain}/reverseQuote`, {
      params: query,
    });

    if (data?.code !== 200) {
      throw new Error(
        `reverseQuote failed: ${data?.msg || data?.error || "unknown error"}`
      );
    }
    return data.data;
  }

  // ---------- Swap (build tx) ----------

  /**
   * Build swap tx – GET /v4/:chain/swap
   * Returns { data, to, value, ... } which you send via ethers Wallet.
   */
  async getSwapTx(params: SwapParams) {
    const query: Record<string, string | number> = {
      inTokenAddress: params.inTokenAddress,
      outTokenAddress: params.outTokenAddress,
      account: params.account,
      sender: params.sender,
      amountDecimals: params.amountDecimals,
      gasPriceDecimals: params.gasPriceDecimals,
    };

    if (params.slippage !== undefined) query.slippage = params.slippage;
    if (params.outAmountDecimals) query.outAmountDecimals = params.outAmountDecimals;
    if (params.referrer) query.referrer = params.referrer;

    const { data } = await this.client.get(`/${this.chain}/swap`, {
      params: query,
    });

    if (data?.code !== 200) {
      throw new Error(`swap tx build failed: ${data?.msg || "unknown error"}`);
    }
    return data.data;
  }

  // ---------- Gasless Swap endpoints ----------

  /**
   * Gasless quote – GET /v4/gasless/{chainId}/quote
   * NOTE: chainId is numeric (56, 1, 8453, etc.)
   */
  async getGaslessQuote(params: GaslessQuoteParams) {
    const query: Record<string, string | number> = {
      inTokenAddress: params.inTokenAddress,
      outTokenAddress: params.outTokenAddress,
      amountDecimals: params.amountDecimals,
      gasPriceDecimals: params.gasPriceDecimals,
      account: params.account,
    };

    if (params.slippage !== undefined) query.slippage = params.slippage;
    if (params.referrer) query.referrer = params.referrer;

    const { data } = await this.client.get(
      `/gasless/${this.chainId}/quote`,
      { params: query }
    );

    if (data?.code !== 200) {
      throw new Error(
        `gasless quote failed: ${data?.msg || data?.error || "unknown error"}`
      );
    }
    return data.data;
  }

  /**
   * Submit gasless swap – POST /v4/gasless/{chainId}/swap
   * Body = what you build after Permit2 signing etc.
   */
  async submitGaslessSwap(body: GaslessSwapBody) {
    const { data } = await this.client.post(
      `/gasless/${this.chainId}/swap`,
      body
    );

    if (data?.err || data?.code && data.code !== 200) {
      throw new Error(
        `gasless swap submit failed: ${data?.msg || data?.err || "unknown error"}`
      );
    }

    // Returns { orderHash, ... }
    return data;
  }

  /**
   * Poll gasless order status – GET /v4/gasless/{chainId}/order?orderHash=...
   */
  async getGaslessOrderStatus(orderHash: string) {
    const { data } = await this.client.get(
      `/gasless/${this.chainId}/order`,
      { params: { orderHash } }
    );

    if (data?.code !== 200) {
      throw new Error(
        `gasless order status failed: ${data?.msg || data?.err || "unknown error"}`
      );
    }

    // data.data.hash is the final tx hash if executed
    return data.data;
  }
}

export default new OpenOceanApi({
    chain: "bsc",
    chainId: 56,
});
