import { TOOLS } from "./schemas";

const MCP_TOOL_NAMES: Record<string, string> = {
  preflight: "solana_preflight",
  crypto: "solana_crypto_market",
  weather: "weather_forecast",
  "token-check": "solana_token_check",
  "tx-preview": "solana_transaction_preview",
  "pool-pulse": "solana_pool_pulse"
};

export function mcpToolDefinitions(base: string, network: string, payTo: string) {
  return TOOLS.map((tool) => {
    const mcpName = MCP_TOOL_NAMES[tool.id] ?? `solana_${tool.id.replace(/-/g, "_")}`;
    const rawSchema = tool.input as Record<string, unknown>;
    // Strip top-level oneOf for strict MCP clients that require a flat object inputSchema
    const { oneOf: _oneOf, ...cleanSchema } = rawSchema;
    return {
      name: mcpName,
      description: `${tool.summary} [x402 v2 paid endpoint: ${tool.method} ${base}${tool.route} (${tool.price} USDC on ${network})]`,
      inputSchema: cleanSchema,
      annotations: {
        title: tool.id,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        x402: {
          version: 2,
          url: `${base}${tool.route}`,
          method: tool.method,
          price: tool.price,
          asset: "USDC",
          network,
          payTo
        }
      }
    };
  });
}

export function mcpManifest(base: string, network: string, payTo: string) {
  return {
    name: "solana-x402-microtools",
    title: "Solana x402 Microtools",
    version: "1.0.0",
    description:
      "6 pay-per-call Solana mainnet x402 v2 microtools settled in USDC via PayAI: Pre-Sign Brief transaction simulation, SPL/Token-2022 mint safety check, Solana new-pool momentum feed (pool-pulse), x402 v2 challenge preflight, Raydium AMM v4 vault ratios, and MET Norway weather.",
    protocol: "mcp",
    protocolVersion: "2025-03-26",
    transport: {
      type: "streamable-http",
      url: `${base}/mcp`
    },
    x402: {
      version: 2,
      network,
      asset: "USDC",
      payTo,
      manifest: `${base}/.well-known/x402.json`,
      openapi: `${base}/openapi.json`
    },
    tools: mcpToolDefinitions(base, network, payTo)
  };
}

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export function handleMcpRpcMessage(
  msg: unknown,
  base: string,
  network: string,
  payTo: string
): Record<string, unknown> | null {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" }
    };
  }
  const req = msg as JsonRpcRequest;
  const hasId = "id" in req && req.id !== undefined;
  const id = req.id ?? null;

  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 request" }
    };
  }

  // JSON-RPC notifications (no id) such as notifications/initialized
  if (!hasId || req.method.startsWith("notifications/")) {
    return null;
  }

  if (req.method === "initialize") {
    const requestedVersion =
      typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2025-03-26";
    const negotiated = requestedVersion === "2024-11-05" ? "2024-11-05" : "2025-03-26";
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: negotiated,
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: "solana-x402-microtools",
          version: "1.0.0"
        },
        instructions:
          `Solana x402 Microtools exposes 6 pay-per-call HTTP endpoints at ${base} settled in USDC on Solana mainnet (${network}) via the x402 v2 protocol. Call any tool's HTTP endpoint with an x402 v2 client (@x402/fetch or x402-mcp) to settle and receive live data.`
      }
    };
  }

  if (req.method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (req.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: mcpToolDefinitions(base, network, payTo)
      }
    };
  }

  if (req.method === "tools/call") {
    const requestedName = typeof req.params?.name === "string" ? req.params.name : "";
    const tool = TOOLS.find(
      (t) => t.id === requestedName || MCP_TOOL_NAMES[t.id] === requestedName
    );
    if (!tool) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${requestedName}` }
      };
    }
    const endpointUrl = `${base}${tool.route}`;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                payment_required: true,
                x402Version: 2,
                tool: MCP_TOOL_NAMES[tool.id] ?? tool.id,
                method: tool.method,
                endpoint: endpointUrl,
                price_usdc: tool.price,
                network,
                payTo,
                example_input: tool.example,
                instructions: `This tool is an x402 v2 pay-per-call HTTP endpoint (${tool.price} USDC on ${network}). Send a ${tool.method} request to ${endpointUrl} using an x402 v2 client (@x402/fetch) to pay and receive the live response.`
              },
              null,
              2
            )
          }
        ]
      }
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${req.method}` }
  };
}
