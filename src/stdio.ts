#!/usr/bin/env node
/**
 * AgentScrape — stdio MCP entry point for Glama Server registry grading.
 *
 * AgentScrape's production surface is a Cloudflare Worker at
 *   https://agent-scrape.healingsunhaven.workers.dev/mcp
 * speaking Streamable HTTP transport with x402 payment.
 *
 * This file is a thin Node.js stdio wrapper that re-declares the same
 * six tools with identical descriptions and schemas, so static
 * analyzers (Glama, MCP Inspector, etc.) can introspect and grade
 * the tool definitions. Tool invocation from stdio returns a redirect
 * message pointing at the hosted Worker, which is where real payment
 * settlement and browser rendering happen.
 *
 * Run locally:  node dist/stdio.js
 * Run via mcp-proxy (Glama style): mcp-proxy node dist/stdio.js
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const HOSTED_URL = "https://agent-scrape.healingsunhaven.workers.dev/mcp";
const VERSION = "0.6.1";

const server = new Server(
  { name: "agent-scrape", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "scrape_webpage",
      description: "Scrape any webpage and return content as markdown, html, text, or json. Pay-per-call web scraping for AI agents.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to scrape (http or https)" },
          format: { type: "string", enum: ["markdown", "html", "text", "json"], description: "Output format (default: markdown)" },
          wait_for: { type: "string", description: "CSS selector to wait for before extracting" },
          wait_ms: { type: "number", description: "Milliseconds to wait after page load (max 10000)" },
          viewport: { type: "string", enum: ["desktop", "mobile", "tablet"], description: "Viewport size (default: desktop)" },
        },
        required: ["url"],
      },
    },
    {
      name: "extract_structured_data",
      description: "AI-powered structured data extraction from any webpage using natural language. Returns JSON matching your prompt or schema.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to extract from" },
          prompt: { type: "string", description: "Natural language description of what to extract" },
          schema: { type: "object", description: "Optional JSON schema for the response" },
          wait_for: { type: "string", description: "CSS selector to wait for before extracting" },
          wait_ms: { type: "number", description: "Milliseconds to wait after page load" },
        },
        required: ["url", "prompt"],
      },
    },
    {
      name: "screenshot_webpage",
      description: "Capture a PNG screenshot of any webpage. Supports desktop, mobile, and tablet viewports, plus full-page mode.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to capture" },
          full_page: { type: "boolean", description: "Capture full scrollable page (default: false)" },
          viewport: { type: "string", enum: ["desktop", "mobile", "tablet"], description: "Viewport size (default: desktop)" },
          wait_for: { type: "string", description: "CSS selector to wait for" },
          wait_ms: { type: "number", description: "Milliseconds to wait after page load" },
        },
        required: ["url"],
      },
    },
    {
      name: "extract_metadata",
      description: "Extract page metadata: title, description, Open Graph, Twitter cards, JSON-LD, canonical URL, and all meta tags.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to extract metadata from" },
        },
        required: ["url"],
      },
    },
    {
      name: "create_browser_session",
      description: "Create a stateful browser session that persists cookies and localStorage across multiple scrape/workflow calls.",
      inputSchema: {
        type: "object",
        properties: {
          ttl_seconds: { type: "number", description: "Session TTL in seconds (default 1800, max 7200)" },
        },
      },
    },
    {
      name: "run_workflow",
      description: "Execute a multi-step browser workflow atomically: navigate, click, type, wait, scroll, screenshot, extract, evaluate. Up to 20 steps.",
      inputSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            description: "Ordered list of workflow steps to execute",
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["navigate", "click", "type", "wait_for", "wait_ms", "scroll", "screenshot", "extract", "extract_ai", "evaluate"], description: "Step action to perform" },
                url: { type: "string", description: "URL to navigate to (for 'navigate' action)" },
                selector: { type: "string", description: "CSS selector (for click, type, wait_for, extract actions)" },
                text: { type: "string", description: "Text to type (for 'type' action)" },
                ms: { type: "number", description: "Milliseconds to wait (for 'wait_ms' action)" },
                full_page: { type: "boolean", description: "Capture full page (for 'screenshot' action)" },
                prompt: { type: "string", description: "Extraction prompt (for 'extract_ai' action)" },
                script: { type: "string", description: "JavaScript to evaluate (for 'evaluate' action)" },
                format: { type: "string", enum: ["markdown", "html", "text"], description: "Output format (for 'extract' action)" },
              },
              required: ["action"],
            },
          },
          session_id: { type: "string", description: "Existing browser session ID to reuse" },
          persist_session: { type: "boolean", description: "Save session state after workflow completes" },
          viewport: { type: "string", enum: ["desktop", "mobile", "tablet"], description: "Viewport size (default: desktop)" },
        },
        required: ["steps"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  return {
    content: [
      {
        type: "text",
        text:
          `AgentScrape is a hosted MCP server running on Cloudflare Workers with x402 payment.\n\n` +
          `Tool '${toolName}' is not executed in this stdio entry point because Cloudflare ` +
          `Browser Rendering and the x402 facilitator only run in the production Worker.\n\n` +
          `To invoke this tool with real payment settlement, connect your MCP client to the ` +
          `hosted endpoint over Streamable HTTP:\n\n` +
          `  ${HOSTED_URL}\n\n` +
          `Example client config:\n` +
          `  {\n` +
          `    "mcpServers": {\n` +
          `      "agent-scrape": {\n` +
          `        "url": "${HOSTED_URL}",\n` +
          `        "transport": "streamable-http"\n` +
          `      }\n` +
          `    }\n` +
          `  }\n\n` +
          `Or via mcp-remote for stdio-only clients:\n` +
          `  npx mcp-remote ${HOSTED_URL}\n\n` +
          `Pricing, payment requirements, and free-tier details are returned in the 402 response ` +
          `header from the hosted Worker. See https://github.com/hshintelligence/agent-scrape for ` +
          `the full integration guide.`,
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
