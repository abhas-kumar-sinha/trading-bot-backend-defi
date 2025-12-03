import dotenv from "dotenv";
import logger from "../utils/logger";

dotenv.config();

export class WalletService {
    private moralisApiKey_1: string = process.env.MORALIS_API_KEY_1;
    private moralisApiKey_2: string = process.env.MORALIS_API_KEY_2;

    public async getWalletTokens(address: string, chain: string): Promise<any> {
        const url = `https://deep-index.moralis.io/api/v2.2/wallets/${address}/tokens?chain=${chain}`;

        // Try with API key 1 first
        let res = await fetch(url, {
            headers: {
                "accept": "application/json",
                "X-API-Key": this.moralisApiKey_1
            }
        });

        if (res.status === 429 || res.status === 403) {
            logger.info(`API Key 1 exhausted (Status: ${res.status}). Falling back to API Key 2...`);

            res = await fetch(url, {
                headers: {
                    "accept": "application/json",
                    "X-API-Key": this.moralisApiKey_2
                }
            });
        }

        const tokens = await res.json();

        return tokens;
    }
}

export default new WalletService();