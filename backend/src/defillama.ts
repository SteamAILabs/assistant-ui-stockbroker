import { tool } from "@langchain/core/tools";
import { number, object, objectUtil, symbol, z } from "zod";
import * as fs from 'fs';
import { getContextVariable } from "@langchain/core/context";
import { LangGraphRunnableConfig } from "@langchain/langgraph"

export async function callDefillamaAPI<
  Output extends Record<string, any> = Record<string, any>
>(fields: {
  endpoint: string;
  params?: Record<string, any>;
}): Promise<Output> {

  let baseURL = ''  ;
  if (process.env.X_LLAMA_API_KEY) {
    baseURL = `https://pro-api.llama.fi/${process.env.X_LLAMA_API_KEY}`;
  }else{
    baseURL = 'https://api.llama.fi';
  }

  
  const headers = {method: 'GET', headers: {accept: '*/*'}};
  let url = `${baseURL}${fields.endpoint}`;
  if (fields.params) {
    const queryParams = new URLSearchParams(fields.params).toString();
    url =  `${url}?${queryParams}`;
  }

  const response = await fetch(url, headers);
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


export const historicalChainTvlQueryTool = tool(
  async (_, config: LangGraphRunnableConfig) => {
    const store = config.store;
    console.log('store:', store);
    // const currentState = getContextVariable("currentState");
    // const userId = config.configurable?.userId;
    const namespace = ["default", "tvl" ];   
    const key =  "historicalChainTvl"
    let data;
    // let refreshNeeded = true;
    // const dataInStore = await store?.get(namespace, key);
    // console.log('data:', dataInStore);
    let lastTimeStamp: number | undefined;

    // if (dataInStore && Array.isArray(dataInStore.value) && dataInStore.value.length > 0) {
    //     const lastEntry = dataInStore.value[dataInStore.value.length - 1];
    //     lastTimeStamp = lastEntry ? lastEntry["date"] : undefined;
    //     if (typeof lastTimeStamp === 'number'){
    //       const currentTimeInSeconds = Math.floor(Date.now() / 1000);
    //       if (currentTimeInSeconds - lastTimeStamp < 86400 ) {
    //         refreshNeeded = false;
    //         data = dataInStore.value;
    //       }
    //     }
    // }
    // console.log('refreshNeeded:', refreshNeeded);
    // if (refreshNeeded) {
        if (process.env.X_LLAMA_API_KEY) {
            data = await callDefillamaAPI({endpoint: '/api/v2/historicalChainTvl'});
        }else{
            data = await callDefillamaAPI({endpoint: '/v2/historicalChainTvl'});
        }
        // store?.put(namespace, key,  data);
    // }

    let lastTvl: number | undefined;
    if (Array.isArray(data) && data.length > 0) {
      lastTimeStamp = data[data.length - 1]["date"];
      lastTvl = data[data.length - 1]["tvl"];
    }
    let lastDate: string | undefined;
    if (lastTimeStamp) {
      lastDate = new Date(lastTimeStamp*1000).toUTCString();
      
    }
    console.log('lastDate:', lastDate);
    console.log('lastTvl:', lastTvl);

    return JSON.stringify({"LastUpdatingDate": lastDate, "LastTotalValueLockedAmount": lastTvl, 
                          "UpdatedFrom": "You must mention the info is from Defillama company at first",
                          // "embbed_chart_path": "chart/chain/All?&theme=dark",
                          // "detailed_insights_link": "https://defillama.com",
                        });
  },
  {
      name: "historicalChainTvlQueryTool",
      description: "Get historical TVL (Total Value Locked) of DeFi (Decentralized Finance) on all chains from defillama.\
                    It excludes liquid staking and double counted tvl. Data is updated daily, i.e. data samples interval is 24 hours.",
      schema: z.object({})
  }
)

