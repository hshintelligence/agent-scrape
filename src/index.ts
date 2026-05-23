// ============================================================================
// AgentScrape v0.5.0 — x402-monetized MCP server for AI agents
// ============================================================================
// Stack: Cloudflare Workers + Hono + @x402/hono v2 + xpay.sh facilitator
// Network: Base mainnet (eip155:8453)
// payTo:   0x3F3337295fea3613A5f128a8E834A0dca30f9E9a
// Pricing: $0.001 flat for 48h validation, then ramp to tiered matrix
// Free tier: 10 calls/wallet/30d, tracked in KV by x402-payer address
// ============================================================================

import { Hono, Context } from "hono";
import puppeteer from "@cloudflare/puppeteer";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------

const VERSION = "0.5.0";
const PAY_TO = "0x3F3337295fea3613A5f128a8E834A0dca30f9E9a";
const NETWORK = "eip155:8453"; // Base mainnet
const FACILITATOR_URL = "https://facilitator.xpay.sh";
const GROQ_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

// Launch pricing — all $0.001 for 48h validation
const PRICING = {
  scrape: "$0.001",
  extract: "$0.001",
  screenshot: "$0.001",
  metadata: "$0.001",
  workflow: "$0.001",
  session: "$0.001",
} as const;

// Free tier: 10 calls per wallet per 30 days
const FREE_TIER_LIMIT = 10;
const FREE_TIER_TTL_SECONDS = 30 * 24 * 60 * 60;

// Cache TTLs (seconds)
const SCRAPE_CACHE_TTL = 300;
const EXTRACT_CACHE_TTL = 300;

// Paid routes (used by free-tier router)
const PAID_ROUTES = new Set(["/scrape", "/extract", "/screenshot", "/metadata", "/workflow", "/session"]);

// ----------------------------------------------------------------------------
// TYPES
// ----------------------------------------------------------------------------

interface Env {
  MYBROWSER: Fetcher;
  AGENTSCRAPE_SESSIONS: KVNamespace;
  GROQ_API_KEY: string;
}

interface ScrapeRequest {
  url: string;
  format?: "markdown" | "html" | "text" | "json";
  wait_for?: string;
  wait_ms?: number;
  viewport?: "desktop" | "mobile" | "tablet";
  session_id?: string;
}

interface ExtractRequest {
  url: string;
  prompt: string;
  schema?: Record<string, unknown>;
  wait_for?: string;
  wait_ms?: number;
  session_id?: string;
}

interface ScreenshotRequest {
  url: string;
  full_page?: boolean;
  viewport?: "desktop" | "mobile" | "tablet";
  wait_for?: string;
  wait_ms?: number;
}

interface MetadataRequest { url: string; }
interface SessionRequest { ttl_seconds?: number; }

interface WorkflowStep {
  action: "navigate" | "click" | "type" | "wait_for" | "wait_ms" | "scroll" | "screenshot" | "extract" | "extract_ai" | "evaluate";
  url?: string;
  selector?: string;
  text?: string;
  ms?: number;
  full_page?: boolean;
  prompt?: string;
  script?: string;
  format?: "markdown" | "html" | "text";
}

interface WorkflowRequest {
  steps: WorkflowStep[];
  session_id?: string;
  persist_session?: boolean;
  viewport?: "desktop" | "mobile" | "tablet";
}

interface SessionState {
  cookies: unknown[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  current_url?: string;
  created_at: string;
}

// ----------------------------------------------------------------------------
// HELPERS — validation, encoding, hashing
// ----------------------------------------------------------------------------

function validateUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http and https URLs are allowed");
    }
    return parsed.toString();
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function buildCacheKey(prefix: string, params: Record<string, unknown>): Promise<string> {
  const sorted = JSON.stringify(params, Object.keys(params).sort());
  const data = new TextEncoder().encode(sorted);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}:${hex}`;
}

function generateSessionId(): string {
  return `sess_${crypto.randomUUID()}`;
}

const VIEWPORTS = {
  desktop: { width: 1920, height: 1080 },
  mobile: { width: 390, height: 844 },
  tablet: { width: 1024, height: 1366 },
};

// ----------------------------------------------------------------------------
// HELPERS — HTML transformation
// ----------------------------------------------------------------------------

function htmlToMarkdown(html: string): string {
  let md = html;
  md = md.replace(/<script[\s\S]*?<\/script>/gi, "");
  md = md.replace(/<style[\s\S]*?<\/style>/gi, "");
  md = md.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**");
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*");
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*");
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, "![$2]($1)");
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![]($1)");
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<[^>]+>/g, "");
  md = md.replace(/&nbsp;/g, " ");
  md = md.replace(/&amp;/g, "&");
  md = md.replace(/&lt;/g, "<");
  md = md.replace(/&gt;/g, ">");
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/\n{3,}/g, "\n\n");
  return md.trim();
}

function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/?(p|div|h[1-6]|li|tr)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]{2,}/g, " ");
  return text.trim();
}

// ----------------------------------------------------------------------------
// HELPERS — Groq AI extraction
// ----------------------------------------------------------------------------

async function groqExtract(
  apiKey: string,
  content: string,
  prompt: string,
  schema?: Record<string, unknown>,
): Promise<unknown> {
  const systemPrompt = schema
    ? `You are a precise data extraction system. Extract structured data from the user's content matching this JSON schema EXACTLY: ${JSON.stringify(schema)}. Return ONLY valid JSON. No markdown, no commentary.`
    : `You are a precise data extraction system. Extract the requested information from the user's content and return as valid JSON. No markdown, no commentary.`;

  const truncated = content.length > 60000 ? content.slice(0, 60000) : content;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `EXTRACTION INSTRUCTION:\n${prompt}\n\nCONTENT:\n${truncated}` },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API error ${response.status}: ${errText}`);
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  const rawContent = data.choices[0].message.content;
  try {
    return JSON.parse(rawContent);
  } catch {
    return { raw: rawContent };
  }
}

// ----------------------------------------------------------------------------
// HELPERS — Metadata extraction
// ----------------------------------------------------------------------------

async function extractMetadataFromPage(page: any): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const get = (sel: string, attr: string = "content") =>
      (document.querySelector(sel) as HTMLElement | null)?.getAttribute(attr) ?? null;

    const allMeta: Record<string, string> = {};
    document.querySelectorAll("meta").forEach(m => {
      const name = m.getAttribute("name") || m.getAttribute("property") || m.getAttribute("itemprop");
      const content = m.getAttribute("content");
      if (name && content) allMeta[name] = content;
    });

    const jsonLd: unknown[] = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      try { jsonLd.push(JSON.parse(s.textContent || "{}")); } catch {}
    });

    return {
      url: window.location.href,
      title: document.title,
      description: get('meta[name="description"]'),
      canonical: get('link[rel="canonical"]', "href"),
      favicon: get('link[rel="icon"]', "href") || get('link[rel="shortcut icon"]', "href"),
      language: document.documentElement.lang || null,
      og: {
        title: get('meta[property="og:title"]'),
        description: get('meta[property="og:description"]'),
        image: get('meta[property="og:image"]'),
        url: get('meta[property="og:url"]'),
        type: get('meta[property="og:type"]'),
        site_name: get('meta[property="og:site_name"]'),
      },
      twitter: {
        card: get('meta[name="twitter:card"]'),
        title: get('meta[name="twitter:title"]'),
        description: get('meta[name="twitter:description"]'),
        image: get('meta[name="twitter:image"]'),
        site: get('meta[name="twitter:site"]'),
      },
      jsonLd,
      allMeta,
    };
  });
}

// ----------------------------------------------------------------------------
// HELPERS — Session state
// ----------------------------------------------------------------------------

async function captureSessionState(page: any): Promise<SessionState> {
  const cookies = await page.cookies();
  const storage = await page.evaluate(() => {
    const ls: Record<string, string> = {};
    const ss: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); if (k) ls[k] = localStorage.getItem(k) || "";
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i); if (k) ss[k] = sessionStorage.getItem(k) || "";
    }
    return { localStorage: ls, sessionStorage: ss, current_url: window.location.href };
  });
  return {
    cookies: cookies as unknown[],
    localStorage: storage.localStorage,
    sessionStorage: storage.sessionStorage,
    current_url: storage.current_url,
    created_at: new Date().toISOString(),
  };
}

async function restoreSessionState(page: any, state: SessionState): Promise<void> {
  if (state.cookies && state.cookies.length > 0) {
    await page.setCookie(...(state.cookies as any[]));
  }
  if (state.current_url) {
    await page.goto(state.current_url, { waitUntil: "domcontentloaded" });
    await page.evaluate((s: { localStorage: Record<string, string>; sessionStorage: Record<string, string> }) => {
      for (const [k, v] of Object.entries(s.localStorage)) localStorage.setItem(k, v);
      for (const [k, v] of Object.entries(s.sessionStorage)) sessionStorage.setItem(k, v);
    }, { localStorage: state.localStorage, sessionStorage: state.sessionStorage });
  }
}

// ----------------------------------------------------------------------------
// FREE TIER — wallet-tracked, KV-backed
// ----------------------------------------------------------------------------

async function checkAndIncrementFreeTier(
  env: Env,
  payerHeader: string | undefined,
): Promise<{ allowed: boolean; remaining: number; wallet: string | null }> {
  if (!payerHeader) return { allowed: false, remaining: 0, wallet: null };

  const wallet = payerHeader.toLowerCase().trim();
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) return { allowed: false, remaining: 0, wallet: null };

  const key = `freetier:${wallet}`;
  const raw = await env.AGENTSCRAPE_SESSIONS.get(key);
  const used = raw ? parseInt(raw, 10) : 0;

  if (used >= FREE_TIER_LIMIT) {
    return { allowed: false, remaining: 0, wallet };
  }

  await env.AGENTSCRAPE_SESSIONS.put(key, String(used + 1), {
    expirationTtl: FREE_TIER_TTL_SECONDS,
  });

  return { allowed: true, remaining: FREE_TIER_LIMIT - used - 1, wallet };
}

// ----------------------------------------------------------------------------
// ENDPOINT HANDLERS — pure logic
// ----------------------------------------------------------------------------

async function handleScrape(c: Context<{ Bindings: Env }>) {
  const body = (await c.req.json()) as ScrapeRequest;
  const url = validateUrl(body.url);
  const format = body.format || "markdown";
  const viewport = body.viewport || "desktop";

  const cacheKey = await buildCacheKey("scrape", { url, format, viewport, wait_for: body.wait_for, wait_ms: body.wait_ms });
  const cached = await c.env.AGENTSCRAPE_SESSIONS.get(cacheKey);
  if (cached) return c.json({ ...JSON.parse(cached), cache: "hit" });

  const browser = await puppeteer.launch(c.env.MYBROWSER);
  const page = await browser.newPage();
  await page.setViewport(VIEWPORTS[viewport]);

  try {
    if (body.session_id) {
      const stateRaw = await c.env.AGENTSCRAPE_SESSIONS.get(`session:${body.session_id}`);
      if (stateRaw) await restoreSessionState(page, JSON.parse(stateRaw));
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (body.wait_for) await page.waitForSelector(body.wait_for, { timeout: 15000 }).catch(() => {});
    if (body.wait_ms) await new Promise(r => setTimeout(r, Math.min(body.wait_ms!, 10000)));

    const html = await page.content();
    let content: unknown;
    if (format === "html") content = html;
    else if (format === "text") content = htmlToText(html);
    else if (format === "json") content = { html, text: htmlToText(html), markdown: htmlToMarkdown(html) };
    else content = htmlToMarkdown(html);

    const result = {
      url, format, content,
      length: typeof content === "string" ? content.length : JSON.stringify(content).length,
      cache: "miss",
    };

    await c.env.AGENTSCRAPE_SESSIONS.put(cacheKey, JSON.stringify(result), { expirationTtl: SCRAPE_CACHE_TTL });
    return c.json(result);
  } finally {
    await browser.close();
  }
}

async function handleExtract(c: Context<{ Bindings: Env }>) {
  const body = (await c.req.json()) as ExtractRequest;
  const url = validateUrl(body.url);
  if (!body.prompt) return c.json({ error: "Missing 'prompt' field" }, 400);

  const cacheKey = await buildCacheKey("extract", { url, prompt: body.prompt, schema: body.schema, wait_for: body.wait_for, wait_ms: body.wait_ms });
  const cached = await c.env.AGENTSCRAPE_SESSIONS.get(cacheKey);
  if (cached) return c.json({ ...JSON.parse(cached), cache: "hit" });

  const browser = await puppeteer.launch(c.env.MYBROWSER);
  const page = await browser.newPage();
  await page.setViewport(VIEWPORTS.desktop);

  try {
    if (body.session_id) {
      const stateRaw = await c.env.AGENTSCRAPE_SESSIONS.get(`session:${body.session_id}`);
      if (stateRaw) await restoreSessionState(page, JSON.parse(stateRaw));
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (body.wait_for) await page.waitForSelector(body.wait_for, { timeout: 15000 }).catch(() => {});
    if (body.wait_ms) await new Promise(r => setTimeout(r, Math.min(body.wait_ms!, 10000)));

    const html = await page.content();
    const text = htmlToText(html);
    const extractStart = Date.now();
    const extracted = await groqExtract(c.env.GROQ_API_KEY, text, body.prompt, body.schema);
    const extractMs = Date.now() - extractStart;

    const result = {
      url, prompt: body.prompt, extracted,
      content_length: text.length, extract_ms: extractMs,
      model: GROQ_MODEL, cache: "miss",
    };

    await c.env.AGENTSCRAPE_SESSIONS.put(cacheKey, JSON.stringify(result), { expirationTtl: EXTRACT_CACHE_TTL });
    return c.json(result);
  } finally {
    await browser.close();
  }
}

async function handleScreenshot(c: Context<{ Bindings: Env }>) {
  const body = (await c.req.json()) as ScreenshotRequest;
  const url = validateUrl(body.url);
  const viewport = body.viewport || "desktop";
  const fullPage = body.full_page ?? false;

  const browser = await puppeteer.launch(c.env.MYBROWSER);
  const page = await browser.newPage();
  await page.setViewport(VIEWPORTS[viewport]);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (body.wait_for) await page.waitForSelector(body.wait_for, { timeout: 15000 }).catch(() => {});
    if (body.wait_ms) await new Promise(r => setTimeout(r, Math.min(body.wait_ms!, 10000)));

    const buffer = await page.screenshot({ fullPage, type: "png" }) as Uint8Array;
    return c.json({
      url, viewport, full_page: fullPage,
      format: "png", bytes: buffer.byteLength,
      data_base64: uint8ToBase64(buffer),
    });
  } finally {
    await browser.close();
  }
}

async function handleMetadata(c: Context<{ Bindings: Env }>) {
  const body = (await c.req.json()) as MetadataRequest;
  const url = validateUrl(body.url);
  const browser = await puppeteer.launch(c.env.MYBROWSER);
  const page = await browser.newPage();
  await page.setViewport(VIEWPORTS.desktop);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const metadata = await extractMetadataFromPage(page);
    return c.json({ url, metadata });
  } finally {
    await browser.close();
  }
}

async function handleSession(c: Context<{ Bindings: Env }>) {
  const body = (await c.req.json().catch(() => ({}))) as SessionRequest;
  const ttl = Math.min(body.ttl_seconds ?? 1800, 7200);
  const sessionId = generateSessionId();
  const state: SessionState = {
    cookies: [], localStorage: {}, sessionStorage: {},
    created_at: new Date().toISOString(),
  };
  await c.env.AGENTSCRAPE_SESSIONS.put(`session:${sessionId}`, JSON.stringify(state), { expirationTtl: ttl });
  return c.json({ session_id: sessionId, ttl_seconds: ttl, created_at: state.created_at });
}

async function handleWorkflow(c: Context<{ Bindings: Env }>) {
  const body = (await c.req.json()) as WorkflowRequest;
  if (!Array.isArray(body.steps) || body.steps.length === 0) return c.json({ error: "steps array required" }, 400);
  if (body.steps.length > 20) return c.json({ error: "max 20 steps per workflow" }, 400);

  const viewport = body.viewport || "desktop";
  const browser = await puppeteer.launch(c.env.MYBROWSER);
  const page = await browser.newPage();
  await page.setViewport(VIEWPORTS[viewport]);

  const results: unknown[] = [];
  const startTime = Date.now();

  try {
    if (body.session_id) {
      const stateRaw = await c.env.AGENTSCRAPE_SESSIONS.get(`session:${body.session_id}`);
      if (stateRaw) await restoreSessionState(page, JSON.parse(stateRaw));
    }

    for (let i = 0; i < body.steps.length; i++) {
      const step = body.steps[i];
      const stepStart = Date.now();
      try {
        if (step.action === "navigate") {
          if (!step.url) throw new Error("navigate requires url");
          await page.goto(validateUrl(step.url), { waitUntil: "domcontentloaded", timeout: 30000 });
          results.push({ step: i, action: "navigate", url: step.url, ms: Date.now() - stepStart });
        } else if (step.action === "click") {
          if (!step.selector) throw new Error("click requires selector");
          await page.click(step.selector);
          results.push({ step: i, action: "click", selector: step.selector, ms: Date.now() - stepStart });
        } else if (step.action === "type") {
          if (!step.selector || step.text === undefined) throw new Error("type requires selector and text");
          await page.type(step.selector, step.text);
          results.push({ step: i, action: "type", selector: step.selector, ms: Date.now() - stepStart });
        } else if (step.action === "wait_for") {
          if (!step.selector) throw new Error("wait_for requires selector");
          await page.waitForSelector(step.selector, { timeout: 15000 });
          results.push({ step: i, action: "wait_for", selector: step.selector, ms: Date.now() - stepStart });
        } else if (step.action === "wait_ms") {
          const ms = Math.min(step.ms ?? 1000, 10000);
          await new Promise(r => setTimeout(r, ms));
          results.push({ step: i, action: "wait_ms", ms_waited: ms, ms: Date.now() - stepStart });
        } else if (step.action === "scroll") {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          results.push({ step: i, action: "scroll", ms: Date.now() - stepStart });
        } else if (step.action === "screenshot") {
          const buffer = await page.screenshot({ fullPage: step.full_page ?? false, type: "png" }) as Uint8Array;
          results.push({ step: i, action: "screenshot", bytes: buffer.byteLength, data_base64: uint8ToBase64(buffer), ms: Date.now() - stepStart });
        } else if (step.action === "extract") {
          const html = await page.content();
          const fmt = step.format || "markdown";
          const content = fmt === "html" ? html : fmt === "text" ? htmlToText(html) : htmlToMarkdown(html);
          results.push({ step: i, action: "extract", format: fmt, content, ms: Date.now() - stepStart });
        } else if (step.action === "extract_ai") {
          if (!step.prompt) throw new Error("extract_ai requires prompt");
          const html = await page.content();
          const text = htmlToText(html);
          const extracted = await groqExtract(c.env.GROQ_API_KEY, text, step.prompt);
          results.push({ step: i, action: "extract_ai", extracted, ms: Date.now() - stepStart });
        } else if (step.action === "evaluate") {
          if (!step.script) throw new Error("evaluate requires script");
          const value = await page.evaluate(step.script);
          results.push({ step: i, action: "evaluate", value, ms: Date.now() - stepStart });
        } else {
          throw new Error(`Unknown action: ${(step as any).action}`);
        }
      } catch (err: any) {
        results.push({ step: i, action: step.action, error: err.message, ms: Date.now() - stepStart });
        break;
      }
    }

    if (body.persist_session && body.session_id) {
      const state = await captureSessionState(page);
      await c.env.AGENTSCRAPE_SESSIONS.put(`session:${body.session_id}`, JSON.stringify(state), { expirationTtl: 1800 });
    }

    return c.json({ steps_executed: results.length, total_ms: Date.now() - startTime, results });
  } finally {
    await browser.close();
  }
}

// Dispatcher: route by pathname for free-tier short-circuit
async function dispatchPaidEndpoint(c: Context<{ Bindings: Env }>): Promise<Response> {
  const path = c.req.path;
  if (path === "/scrape") return handleScrape(c);
  if (path === "/extract") return handleExtract(c);
  if (path === "/screenshot") return handleScreenshot(c);
  if (path === "/metadata") return handleMetadata(c);
  if (path === "/workflow") return handleWorkflow(c);
  if (path === "/session") return handleSession(c);
  return c.json({ error: "Unknown endpoint" }, 404);
}

// ----------------------------------------------------------------------------
// HONO APP — factory pattern with free-tier short-circuit BEFORE x402
// ----------------------------------------------------------------------------

function buildApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();

  // Free / health endpoint
  app.get("/", (c) => {
    return c.json({
      service: "AgentScrape",
      version: VERSION,
      description: "x402-monetized scraping toolkit for AI agents",
      payTo: PAY_TO,
      network: NETWORK,
      facilitator: FACILITATOR_URL,
      free_tier: {
        limit_per_wallet: FREE_TIER_LIMIT,
        window_days: 30,
        header: "x402-payer (wallet address)",
      },
      tools: {
        scrape: { price: PRICING.scrape, method: "POST", description: "Scrape any URL to markdown/html/text/json" },
        extract: { price: PRICING.extract, method: "POST", description: "AI-powered structured extraction (Groq + Llama 4)" },
        screenshot: { price: PRICING.screenshot, method: "POST", description: "PNG screenshot with viewport control" },
        metadata: { price: PRICING.metadata, method: "POST", description: "Extract title, OG, Twitter, JSON-LD" },
        workflow: { price: PRICING.workflow, method: "POST", description: "Multi-step atomic execution" },
        session: { price: PRICING.session, method: "POST", description: "Stateful browser session" },
      },
      model: GROQ_MODEL,
    });
  });

  // FREE-TIER SHORT-CIRCUIT — runs BEFORE x402 middleware, can fully handle request
  app.use("*", async (c, next) => {
    const path = c.req.path;
    const method = c.req.method;
    if (method !== "POST" || !PAID_ROUTES.has(path)) return next();

    // If request already includes x402 payment header, skip free tier and let x402 process it
    if (c.req.header("X-PAYMENT") || c.req.header("x-payment")) return next();

    const payer = c.req.header("x402-payer") || c.req.header("X402-Payer");
    const result = await checkAndIncrementFreeTier(c.env, payer);
    if (result.allowed) {
      // SHORT-CIRCUIT: handle request directly, skip x402 entirely
      const response = await dispatchPaidEndpoint(c);
      response.headers.set("X-Free-Tier-Remaining", String(result.remaining));
      response.headers.set("X-Free-Tier-Wallet", result.wallet || "");
      return response;
    }

    // No free tier available → fall through to x402 middleware
    return next();
  });

  // x402 payment middleware
  const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(NETWORK, new ExactEvmScheme());

  app.use(
    paymentMiddleware(
      {
        "POST /scrape": { accepts: { scheme: "exact", price: PRICING.scrape, network: NETWORK, payTo: PAY_TO }, description: "Scrape any URL to markdown/html/text/json" },
        "POST /extract": { accepts: { scheme: "exact", price: PRICING.extract, network: NETWORK, payTo: PAY_TO }, description: "AI-powered structured extraction via Groq + Llama 4 Scout" },
        "POST /screenshot": { accepts: { scheme: "exact", price: PRICING.screenshot, network: NETWORK, payTo: PAY_TO }, description: "PNG screenshot with viewport control (desktop/mobile/tablet)" },
        "POST /metadata": { accepts: { scheme: "exact", price: PRICING.metadata, network: NETWORK, payTo: PAY_TO }, description: "Extract title, description, OG, Twitter cards, JSON-LD" },
        "POST /workflow": { accepts: { scheme: "exact", price: PRICING.workflow, network: NETWORK, payTo: PAY_TO }, description: "Multi-step atomic execution (navigate/click/type/extract/extract_ai/screenshot)" },
        "POST /session": { accepts: { scheme: "exact", price: PRICING.session, network: NETWORK, payTo: PAY_TO }, description: "Create stateful browser session with cookie/localStorage persistence" },
      },
      resourceServer,
    ),
  );

  // Paid endpoints (reached after x402 middleware approves payment)
  app.post("/scrape", handleScrape);
  app.post("/extract", handleExtract);
  app.post("/screenshot", handleScreenshot);
  app.post("/metadata", handleMetadata);
  app.post("/workflow", handleWorkflow);
  app.post("/session", handleSession);

  app.notFound((c) => c.json({ error: "Not Found", available_endpoints: ["GET /", "POST /scrape", "POST /extract", "POST /screenshot", "POST /metadata", "POST /workflow", "POST /session"] }, 404));

  app.onError((err, c) => {
    console.error("Worker error:", err);
    return c.json({ error: err.message || "Internal Server Error" }, 500);
  });

  return app;
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => {
    const app = buildApp(env);
    return app.fetch(req, env, ctx);
  },
};
