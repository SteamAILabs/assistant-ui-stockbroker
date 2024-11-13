import { ToolNode } from "@langchain/langgraph/prebuilt";
import {
  Annotation,
  MemorySaver,
  END,
  START,
  StateGraph,
  NodeInterrupt,
  MessagesAnnotation,
} from "@langchain/langgraph";
import {
  BaseMessage,
  ToolMessage,
  type AIMessage,
} from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import {
  priceSnapshotTool,
  StockPurchase,
  ALL_TOOLS_LIST,
  webSearchTool,
} from "tools.js";

import {coinPriceQueryTool, supportedCryptos} from './coingecko_tools.js';
import { z } from "zod";

import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();


const GraphAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  requestedStockPurchaseDetails: Annotation<StockPurchase>,
  requestedCoinPurchaseDetails: Annotation<Record<string, any>>,
});

const llm = new ChatOpenAI({
  model: process.env.MODEL_NAME || "gpt-4o-mini",
  temperature: 0,
});

const llmWithTools = llm.bindTools(ALL_TOOLS_LIST);
const toolNode = new ToolNode(ALL_TOOLS_LIST);

const callModel = async (state: typeof GraphAnnotation.State) => {
  const { messages } = state;

  const systemMessage = {
    role: "system",
    content:
     "You're an expert financial analyst named AI Steam Search, developed by AI Steam Labs. Your task is to answer users' questions about a given company or companies. You do not have up-to-date information on the companies, so you must call tools " +
      "when answering users' questions. All financial data tools require a company ticker to be passed in as a parameter. If you do not know the ticker, use the web search tool to find it. " +
      "Additionally, you are an innovative AI search engine developed by AI Steam Labs, combining conversational interaction with information linkage. You offer a precise and personalized search experience through natural language processing. " + 
      "If users ask questions like 'Who are you?' or inquire about your identity, respond in the user's input language, highlighting the following key points about AI Steam Search: " + 
      "Conversational Search: You can understand natural language queries and provide direct answers, not just a list of links. " + 
      "Information Integration & Task-oriented Needs: You ensure accurate and reliable information by integrating data from multiple sources and using AI Steam Labs’ multi-agent system for query decomposition, comparison, and correction. " + 
      "Multi-round Conversation Support: You allow users to engage in deeper discussions within a single query, enhancing flexibility. " +
      "Cross-language Support: You handle queries in multiple languages, catering to diverse user needs. " +
      "Technical Strength: You utilize large language models like GPT and self-developed agents, enhanced by Retrieval-Augmented Generation (RAG) for real-time information retrieval and reducing hallucinations. " +
      "Future Plans: AI Steam Search's upcoming features include an advanced Solana asset trading version, providing users with enhanced search and trading capabilities."
  };
  
  const result = await llmWithTools.invoke([systemMessage, ...messages]);
  return { messages: result };
};

const shouldContinue = (state: typeof GraphAnnotation.State) => {
  const { messages, requestedStockPurchaseDetails, requestedCoinPurchaseDetails } = state;

  const lastMessage = messages[messages.length - 1];

  // Cast here since `tool_calls` does not exist on `BaseMessage`
  const messageCastAI = lastMessage as AIMessage;
  if (messageCastAI._getType() !== "ai" || !messageCastAI.tool_calls?.length) {
    // LLM did not call any tools, or it's not an AI message, so we should end.
    return END;
  }

  // If `requestedStockPurchaseDetails` is present, we want to execute the purchase
  if (requestedStockPurchaseDetails || requestedCoinPurchaseDetails) {
    return "execute_purchase";
  }

  const { tool_calls } = messageCastAI;
  if (!tool_calls?.length) {
    throw new Error(
      "Expected tool_calls to be an array with at least one element"
    );
  }

  return tool_calls.map((tc) => {
    if (tc.name === "purchase_stock" || tc.name === "purchase_coin") {
      // The user is trying to purchase a stock or crypto coin, route to the verify purchase node.
      return "prepare_purchase_details";
    } else {
      return "tools";
    }
  });
};

const findCompanyName = async (companyName: string) => {
  // Use the web search tool to find the ticker symbol for the company.
  const searchResults: string = await webSearchTool.invoke(
    `What is the ticker symbol for ${companyName}?`
  );
  const llmWithTickerOutput = llm.withStructuredOutput(
    z
      .object({
        ticker: z.string().describe("The ticker symbol of the company"),
      })
      .describe(
        `Extract the ticker symbol of ${companyName} from the provided context.`
      ),
    { name: "extract_ticker" }
  );
  const extractedTicker = await llmWithTickerOutput.invoke([
    {
      role: "user",
      content: `Given the following search results, extract the ticker symbol for ${companyName}:\n${searchResults}`,
    },
  ]);

  return extractedTicker.ticker;
};

const preparePurchaseDetails = async (state: typeof GraphAnnotation.State) => {
  const { messages } = state;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage._getType() !== "ai") {
    throw new Error("Expected the last message to be an AI message");
  }

  // Cast here since `tool_calls` does not exist on `BaseMessage`
  const messageCastAI = lastMessage as AIMessage;
  const purchaseStockTool = messageCastAI.tool_calls?.find(
    (tc) => tc.name === "purchase_stock" || tc.name === "purchase_coin"
  );

  if (!purchaseStockTool) {
    throw new Error(
      "Expected the last AI message to have a purchase_stock tool call"
    );
  }

  if (purchaseStockTool.name === "purchase_stock") {
    let { maxPurchasePrice, companyName, ticker } = purchaseStockTool.args;

    if (!ticker) {
      if (!companyName) {
        // The user did not provide the ticker or the company name.
        // Ask the user for the missing information. Also, if the
        // last message had a tool call we need to add a tool message
        // to the messages array.
        const toolMessages = messageCastAI.tool_calls?.map((tc) => {
          return {
            role: "tool",
            content: `Please provide the missing information for the ${tc.name} tool.`,
            id: tc.id,
          };
        });

        return {
          messages: [
            ...(toolMessages ?? []),
            {
              role: "assistant",
              content:
                "Please provide either the company ticker or the company name to purchase stock. If you're trying to buy crypto coins, please provide crypto symbol name",
            },
          ],
        };
      } else {
        // The user did not provide the ticker, but did provide the company name.
        // Call the `findCompanyName` tool to get the ticker.
        ticker = await findCompanyName(purchaseStockTool.args.companyName);
      }
    }

    if (!maxPurchasePrice) {
      // If `maxPurchasePrice` is not defined, default to the current price.
      const priceSnapshot = await priceSnapshotTool.invoke({ ticker });
      if (priceSnapshot === null) {
        maxPurchasePrice = 0;
      } else {
        maxPurchasePrice = JSON.parse(priceSnapshot).snapshot.price;
      }
    }
    return {
      requestedStockPurchaseDetails: {
        ticker,
        quantity: purchaseStockTool.args.quantity ?? 1, // Default to one if not provided.
        maxPurchasePrice,
      },
    };
  } else if (purchaseStockTool.name === "purchase_coin") {
    let { symbol, coinName, quantity, maxPurchasePrice } = purchaseStockTool.args;

    if (!maxPurchasePrice) {
      const priceinfoString = await coinPriceQueryTool.invoke({ symbols: symbol });
      if (priceinfoString !== null) {
        const priceinfo = JSON.parse(priceinfoString);
        const currencyPrefix = priceinfo.vs_currencies;
        maxPurchasePrice = priceinfo[currencyPrefix];
      }
    }

    if (symbol in supportedCryptos) {
      coinName = supportedCryptos[symbol]["name"];
    }
    return {
      requestedCoinPurchaseDetails: {
        symbol,
        coinName,
        quantity: quantity ?? 1, // Default to one if not provided.
        maxPurchasePrice,
      },
    };
  }

  // Add a default return statement to handle any unexpected paths
  return {
    messages: [
      {
        role: "assistant",
        content: "Unable to prepare purchase details. Please check your input.",
      },
    ],
  };
};

const purchaseApproval = async (state: typeof GraphAnnotation.State) => {
  const { messages } = state;
  const lastMessage = messages[messages.length - 1];
  if (!(lastMessage instanceof ToolMessage)) {
    // Interrupt the node to request permission to execute the purchase.
    throw new NodeInterrupt("Please confirm the purchase before executing.");
  }
};

const shouldExecute = (state: typeof GraphAnnotation.State) => {
  const { messages } = state;
  const lastMessage = messages[messages.length - 1];
  if (!(lastMessage instanceof ToolMessage)) {
    // Interrupt the node to request permission to execute the purchase.
    throw new NodeInterrupt("Please confirm the purchase before executing.");
  }

  const { approve } = JSON.parse(lastMessage.content as string);
  return approve ? "execute_purchase" : "agent";
};

const executePurchase = async (state: typeof GraphAnnotation.State) => {
  const { requestedStockPurchaseDetails, requestedCoinPurchaseDetails } = state;

  let ticker: string =""
  let quantity: number | undefined = 0
  let maxPurchasePrice: number | undefined = 0
  if (requestedCoinPurchaseDetails){
      quantity = requestedCoinPurchaseDetails.quantity
      maxPurchasePrice  = requestedCoinPurchaseDetails.maxPurchasePrice;
      ticker = requestedCoinPurchaseDetails.symbol
  }else if (requestedStockPurchaseDetails){
    quantity = requestedStockPurchaseDetails.quantity
    maxPurchasePrice  = requestedStockPurchaseDetails.maxPurchasePrice;
    ticker = requestedStockPurchaseDetails.ticker
  }

  const toolCallId = "tool_" + Math.random().toString(36).substring(2);
  return {
    messages: [
      {
        type: "ai",
        tool_calls: [
          {
            name: "execute_purchase",
            id: toolCallId,
            args: {
              ticker,
              quantity,
              maxPurchasePrice,
            },
          },
        ],
      },
      {
        type: "tool",
        name: "execute_purchase",
        tool_call_id: toolCallId,
        content: JSON.stringify({
          success: true,
        }),
      },
      {
        type: "ai",
        content:
          `Successfully purchased ${quantity} share(s) of ` +
          `${ticker} at $${maxPurchasePrice}/share.`,
      },
    ],
  };
};

const workflow = new StateGraph(GraphAnnotation)
  .addNode("agent", callModel)
  .addEdge(START, "agent")
  .addNode("tools", toolNode)
  .addNode("prepare_purchase_details", preparePurchaseDetails)
  .addNode("purchase_approval", purchaseApproval)
  .addNode("execute_purchase", executePurchase)
  .addEdge("prepare_purchase_details","purchase_approval")
  .addEdge("execute_purchase", END)
  .addEdge("tools", "agent")
  .addConditionalEdges("purchase_approval", shouldExecute, [
    "agent",
    "execute_purchase",
  ])
  .addConditionalEdges("agent", shouldContinue, [
    "tools",
    END,
    "prepare_purchase_details",
  ]);

export const graph = workflow.compile({
  checkpointer: new MemorySaver(),
  // store: new InMemoryStore()
  // interruptBefore: ["purchase_approval"]
});



// let config = { configurable: { thread_id: "1", userId: "1" } };
// let inputMessage = { type: "user", content: "what's the tvl of defi?" };

// const callGraphSync = async () => {
//   try {
//     const stream = await graph.stream(
//       { messages: [inputMessage] },
//       { ...config, streamMode: ["messages", "custom"] }
//     );

//     for await (const chunk of stream) {
//       console.log(chunk);
//     }
//   } catch (error) {
//     console.error("Error processing stream:", error);
//   }
// }

// callGraphSync();
