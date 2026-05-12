import { GoogleGenerativeAI, FunctionDeclaration, SchemaType } from '@google/generative-ai';
import { expoDb } from '../../db/index'; 

// ==========================================
// PRE-DEFINED STRICT TOOLS (PRIORITY 1)
// ==========================================
const getTotalBalanceDeclaration: FunctionDeclaration = {
  name: 'get_total_balance',
  description: 'Gets the user\'s total net financial balance (all income combined with all expenses). Use this when asked for "total balance" or "how much money I have left overall".',
};

const getCategorySpendingDeclaration: FunctionDeclaration = {
  name: 'get_category_spending',
  description: 'Gets the total amount spent within a specific category (e.g., Groceries, Transport, Food).',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      category: { type: SchemaType.STRING, description: 'The category to filter by (e.g., "Groceries", "Transport").' }
    },
    required: ['category'],
  },
};

const getRecentTransactionsDeclaration: FunctionDeclaration = {
  name: 'get_recent_transactions',
  description: 'Fetches a list of the most recent transactions.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      limit: { type: SchemaType.NUMBER, description: 'The number of transactions to return (e.g., 5).' }
    },
    required: ['limit'],
  },
};

// ==========================================
// FALLBACK TOOLS (PRIORITY 2)
// ==========================================
const executeSqlDeclaration: FunctionDeclaration = {
  name: 'execute_sql_query',
  description: 'FALLBACK ONLY: Executes a raw SQL SELECT query. Use this ONLY if the pre-defined tools (get_total_balance, get_category_spending, get_recent_transactions) cannot answer the user\'s highly specific question.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      query: { type: SchemaType.STRING, description: 'A valid SQLite SELECT query targeting ai_transactions_view.' }
    },
    required: ['query'],
  },
};

const calculatorDeclaration: FunctionDeclaration = {
  name: 'calculator',
  description: 'Performs basic mathematical operations.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      operation: { type: SchemaType.STRING, description: 'The operation: "add", "subtract", "multiply", "divide"' },
      a: { type: SchemaType.NUMBER, description: 'The first number' },
      b: { type: SchemaType.NUMBER, description: 'The second number' },
    },
    required: ['operation', 'a', 'b'],
  },
};

export const askFinancialAgent = async (
  userPrompt: string, 
  apiKey: string, 
  modelName: string,
  mode: 'rag' | 'dump',
  onStatusChange?: (status: string) => void
): Promise<string> => {

  const injectionPatterns = [/ignore all previous/i, /forget your instructions/i, /you are now a/i, /system prompt/i];
  for (const pattern of injectionPatterns) {
    if (pattern.test(userPrompt)) return "🛡️ **GUARDRAIL TRIGGERED:** Potential prompt injection detected. Request blocked.";
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const cleanModelName = modelName.replace('models/', '');
  const today = new Date();

  // ==========================================
  // DUMP MODE (FULL CONTEXT INJECTION)
  // ==========================================
  if (mode === 'dump') {
    onStatusChange?.('Dumping entire database into context...');
    try {
      const allData = expoDb.getAllSync('SELECT * FROM ai_transactions_view');
      const stringifiedData = JSON.stringify(allData);

      const dumpSystemInstruction = `You are Silo, a highly precise personal finance assistant. 
        FORMATTING RULES: 
        - Talk TO the user (e.g., "You spent"). 
        - Format all money in Indonesian Rupiah (e.g., Rp 150,000). 
        - NEVER use dollar signs.
      === DATABASE DUMP ===
      ${stringifiedData}
      =====================`;

      const model = genAI.getGenerativeModel({
        model: cleanModelName, 
        systemInstruction: { role: 'system', parts: [{ text: dumpSystemInstruction }] },
      });

      onStatusChange?.('Synthesizing answer...');
      const chat = model.startChat();
      const result = await chat.sendMessage(userPrompt);
      return result.response.text() || "No response generated.";
    } catch (error: any) {
      return `⚠️ **Dump Mode Error:** ${error.message}`;
    }
  }
  
  // ==========================================
  // HYBRID RAG MODE
  // ==========================================
  const systemInstruction = `You are Silo, a highly precise personal finance assistant.
  
  CORE RULES:
  0. Today's date is ${today.toLocaleDateString('en-US')}.
  
  1. TOOL SELECTION HIERARCHY (CRITICAL):
     - ALWAYS prioritize using 'get_total_balance', 'get_category_spending', or 'get_recent_transactions' if they apply.
     - ONLY use 'execute_sql_query' if the user asks a complex question that the predefined tools cannot handle (e.g., "What did I buy on Tuesday?" or "Show me only expenses over 50,000").
  
  2. SQL FALLBACK RULES: Query 'ai_transactions_view'. Columns: id, merchant_name, total_amount (expenses are negative), type, date, category. Always use LIKE for text matching.
  
  3. STOP AND RESPOND: Once a tool returns data, stop calling tools.
  
  4. FORMATTING: Talk TO the user (e.g., "You spent"). Format all money in Indonesian Rupiah (e.g., Rp 150,000). NEVER use dollar signs.`;

  const model = genAI.getGenerativeModel({
    model: cleanModelName, 
    systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
    tools: [{ 
      functionDeclarations: [
        getTotalBalanceDeclaration, 
        getCategorySpendingDeclaration, 
        getRecentTransactionsDeclaration, 
        executeSqlDeclaration, 
        calculatorDeclaration
      ] 
    }],
  });

  const chat = model.startChat();

  try {
    onStatusChange?.('Analyzing intent...');
    let result = await chat.sendMessage(userPrompt);
    let calls = result.response.functionCalls();
    let loopCount = 0;

    while (calls && calls.length > 0 && loopCount < 5) {
      loopCount++;
      const functionResponses = [];

      for (const call of calls) {
        let toolResponseData: any = {};

        // ----------------------------------------------------
        // PRE-DEFINED ROUTER EXECUTIONS
        // ----------------------------------------------------
        if (call.name === 'get_total_balance') {
          onStatusChange?.('Fetching total balance...');
          const rows = expoDb.getAllSync('SELECT SUM(total_amount) as total FROM ai_transactions_view');
          toolResponseData = { result: rows[0] };

        } else if (call.name === 'get_category_spending') {
          const { category } = call.args as any;
          onStatusChange?.(`Calculating spending for ${category}...`);
          // We safely parameterize the category lookup inside the app code!
          const rows = expoDb.getAllSync(`SELECT SUM(total_amount) as total FROM ai_transactions_view WHERE category LIKE '%${category}%'`);
          toolResponseData = { categoryFilter: category, result: rows[0] };

        } else if (call.name === 'get_recent_transactions') {
          const { limit } = call.args as any;
          onStatusChange?.(`Fetching last ${limit} transactions...`);
          const rows = expoDb.getAllSync(`SELECT merchant_name, total_amount, category, date FROM ai_transactions_view ORDER BY date DESC LIMIT ${limit}`);
          toolResponseData = { result: rows };

        // ----------------------------------------------------
        // FALLBACK SQL EXECUTOR
        // ----------------------------------------------------
        } else if (call.name === 'execute_sql_query') {
          onStatusChange?.('Generating custom query...');
          const { query } = call.args as any;
          try {
            const cleanQuery = query.replace(/```sql/ig, '').replace(/```/g, '').trim();
            if (!cleanQuery.toUpperCase().startsWith('SELECT')) {
              toolResponseData = { error: "Security Violation: Only SELECT queries are permitted." };
            } else {
              const rows = expoDb.getAllSync(cleanQuery);
              toolResponseData = { message: "Query successful", rowCount: rows.length, data: rows };
            }
          } catch (err: any) {
            toolResponseData = { error: `SQL Execution failed: ${err.message}.` };
          }
        
        // ----------------------------------------------------
        // CALCULATOR TOOL
        // ----------------------------------------------------
        } else if (call.name === 'calculator') {
          const { operation, a, b } = call.args as any;
          onStatusChange?.(`Calculating...`);
          let mathResult: number | string = 0;
          switch(operation) {
            case 'add': mathResult = a + b; break;
            case 'subtract': mathResult = a - b; break;
            case 'multiply': mathResult = a * b; break;
            case 'divide': mathResult = b !== 0 ? a / b : "Error: Divide by zero"; break;
            default: mathResult = "Error: Unknown operation";
          }
          toolResponseData = { result: mathResult };

        } else {
          toolResponseData = { error: `Tool ${call.name} not recognized.` };
        }

        functionResponses.push({ functionResponse: { name: call.name, response: toolResponseData } });
      }

      onStatusChange?.('Synthesizing answer...');
      result = await chat.sendMessage(functionResponses);
      calls = result.response.functionCalls();
    }

    return result.response.text() || "I am not sure how to answer that based on the current context.";

  } catch (error) {
    console.error("Agent Error:", error);
    return "Connection failed or the model encountered a severe error. Please check your API limits or try a different model.";
  }
};

export const analyzeReceiptImage = async (
  base64Image: string,
  apiKey: string, 
  modelName: string
): Promise<{ merchantName?: string, totalAmount?: number, category?: string, date?: string } | null> => {
  
  const genAI = new GoogleGenerativeAI(apiKey);
  const cleanModelName = modelName.replace('models/', '');
  
  const systemInstruction = `You are an expert receipt data extractor. 
  Analyze the provided image of a receipt and extract the merchant name, the final total amount, the date, and guess the best category.
  
  RULES:
  1. Return ONLY a valid JSON object. Do not include markdown formatting like \`\`\`json.
  2. The 'totalAmount' must be a positive number.
  3. The 'category' must closely match one of standard personal finance categories (e.g., Groceries, Food & Dining, Transport, Bills).
  4. The 'date' must be in YYYY-MM-DD format. If no date is found, return null.
  
  EXPECTED OUTPUT FORMAT:
  {
    "merchantName": "Store Name",
    "totalAmount": 150000,
    "category": "Groceries",
    "date": "2026-05-08"
  }`;

  const model = genAI.getGenerativeModel({
    model: cleanModelName, 
    systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
    generationConfig: { responseMimeType: "application/json" } 
  });

  try {
    const result = await model.generateContent([
      {
        inlineData: {
          data: base64Image,
          mimeType: "image/jpeg"
        }
      },
      "Extract the receipt data into JSON based on your system instructions."
    ]);
    
    let text = result.response.text();
    text = text.replace(/```json/ig, '').replace(/```/g, '').trim();
    return JSON.parse(text);
    
  } catch (error) {
    console.error("Receipt Vision Parsing Error:", error);
    return null;
  }
};

