import type { ProviderResult, TokenMarketData } from "../types/domain.js";

export interface MarketDataProvider {
  readonly name: string;
  getMarketData(chainId: number, contractAddress: string): Promise<ProviderResult<TokenMarketData>>;
}
