import { tool } from "@langchain/core/tools";
import { number, object, objectUtil, symbol, z } from "zod";
import * as fs from 'fs';


const rawData = fs.readFileSync('./supported_coins.json', 'utf-8');
export const supportedCryptos = JSON.parse(rawData);

export async function callCoinGeckoAPI<
  Output extends Record<string, any> = Record<string, any>
>(fields: {
  endpoint: string;
  params: Record<string, any>;
}): Promise<Output> {

  let api_key_query_string = '';
  let baseURL = ''  ;
  if (process.env.X_CG_PRO_API_KEY) {
    baseURL = 'https://pro-api.coingecko.com';
    api_key_query_string = 'x_cg_pro_api_key=${apiKey}';
  }else if (process.env.X_CG_API_KEY) {
    baseURL = 'https://api.coingecko.com';
    api_key_query_string = 'x_cg_api_key=${apiKey}';

  }else {
    throw new Error('Environment variable X_CG_PRO_API_KEY is not set');
  }

  const queryParams = new URLSearchParams(fields.params).toString();
  const options = {method: 'GET', headers: {accept: 'application/json'}};
  const url = `${baseURL}${fields.endpoint}?${queryParams}&${api_key_query_string}`;

  const response = await fetch(url, options);

  if (!response.ok) {
    let res: string;
    try {
      res = JSON.stringify(await response.json(), null, 2);
    } catch (_) {
      try {
        res = await response.text();
      } catch (_) {
        res = response.statusText;
      }
    }
    throw new Error(
      `Failed to fetch data from ${fields.endpoint}.\nResponse: ${res}`
    );
  }
  const data = await response.json();
  return data;  
}

export const coinPriceQueryTool =  tool(
  async (input) => {
    let _notSupportedSymbols : string[] = []
    let supportedSymbols : string[] = []
    input.symbols.split(",").forEach(symbol=>{
      symbol = symbol.trim().toLowerCase()
      if (!(symbol in supportedCryptos)){
        _notSupportedSymbols.push(symbol)
      }else{
        const coin_id  = supportedCryptos[symbol]["id"]
        supportedSymbols.push(coin_id)
      }
    })
    if (supportedSymbols.length  == 0) {
      return JSON.stringify({"unsupported_coins" : `${supportedSymbols.join(",")}`})
    }
    try {
      const data = await callCoinGeckoAPI<Record<string, any>>({
        endpoint: "/api/v3/simple/price",
        params: {
          ids: `${supportedSymbols.join(",")}`,
          vs_currencies: input.vs_currencies,
          include_market_cap:  input.include_market_cap,
          include_24hr_change:  input.include_24hr_change,
          include_last_updated_at:  input.include_last_updated_at,
          include_24hr_vol:  input.include_24hr_vol,
        },
      });
      for (const coinId in data) {
        const coinData = data[coinId];
        
        // Check if the current item is of type CoinPriceData and not a string
        if (typeof coinData !== 'string') {
          // Assign the vs_currencies value
          coinData.vs_currencies = input.vs_currencies;
          coinData.symbol  = supportedCryptos[coinId]["name"]
        }
      }
      if (_notSupportedSymbols.length>0) {
        data["unsupported_coins"] = `${_notSupportedSymbols.join(",")}`; 
      }
      return JSON.stringify(data, null);
    } catch (e: any) {
      console.warn("Error fetching coin price for ", input.symbols, e.message);
      return JSON.stringify({ "ErrorHappened": `An error occurred while fetching coin price: ${e.message}`});
    } 
  },
  {
    name: "coin_price",
    description:
      "Retrieves prices for specified cryptocurrent symbols against specified currency. Also showing its market caps, 24hrs changes and traded vol in 24hrs. Multiple cryptocurrent symbols shall be separated via semi-common.",
    schema: z.object({
      symbols: z.string().describe("cryptocurrent symbols to be queried. Example: 'bitcoin,eth'"),
      vs_currencies: z
        .enum(["eur", "usd", "btc", "eth"])
        .describe("The currency used to measure symbols' price.")
        .optional()
        .default("usd"),
      include_market_cap: z
        .boolean()
        .describe("query cryptocurrent symbols' market cap value or not")
        .optional()
        .default(true),
      include_24hr_change: z
        .boolean()
        .describe("eable or disable querying cryptocurrent symbols' price changed value than 24hrs ago")
        .optional()
        .default(true),
      include_last_updated_at: z
        .boolean()
        .describe("eable or disable querying cryptocurrent symbols' price last updating time")
        .optional()
        .default(true),
      include_24hr_vol: z
        .boolean()
        .describe("eable or disable querying cryptocurrent symbols' traded volumns in 24hrs")
        .optional()
        .default(true),                        
    }),
  }
);

const CoinPurchaseSchema = z.object({
  symbol: z
    .string()
    .describe("The symbol of the crypto coin. Example: 'bitcoin'"),
  coinName: z
    .string()
    .describe("The crypto coins name to purchase. It is usally same as the symbol but not always. Example: 'Bitcoin"),
  quantity: z
    .number()
    .int()
    .positive()
    .optional()
    .default(1)
    .describe("The quantity of crypto coins to purchase."),
  maxPurchasePrice: z
    .number()
    .positive()
    .optional()
    .describe("The max price at which to purchase the crypto coin. Defaults to the current price."),
});

export type CoinPurchase = z.infer<typeof CoinPurchaseSchema>;


export const purchaseCoinTool = tool(
  (input) => {
    return (
      `Please confirm that you want to purchase ${input.quantity} shares of ${input.symbol} at ` +
      `${
        input.maxPurchasePrice
          ? `$${input.maxPurchasePrice} per share`
          : "the current price"
      }.`
    );
  },
  {
    name: "purchase_coin",
    description:
      "This tool should be called when a user wants to purchase a crypto currency coin.",
    schema: CoinPurchaseSchema,
  }
);