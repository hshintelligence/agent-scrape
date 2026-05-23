import puppeteer from "@cloudflare/puppeteer";

interface Env {
	MYBROWSER: Fetcher;
	GROQ_API_KEY: string;
}

interface ScrapeRequest {
	url: string;
	output_format?: "markdown" | "html" | "text" | "json";
	wait_for?: string;
	timeout_ms?: number;
}

interface ExtractRequest {
	url: string;
	instruction: string;
	schema?: Record<string, unknown>;
	wait_for?: string;
	timeout_ms?: number;
}

const GROQ_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function htmlToText(html: string): string {
	return html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function htmlToMarkdown(html: string): string {
	let md = html;
	md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
	md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
	md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "\n# $1\n");
	md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "\n## $1\n");
	md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "\n### $1\n");
	md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "\n#### $1\n");
	md = md.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**");
	md = md.replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**");
	md = md.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*");
	md = md.replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*");
	md = md.replace(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");
	md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");
	md = md.replace(/<br\s*\/?>/gi, "\n");
	md = md.replace(/<\/p>/gi, "\n\n");
	md = md.replace(/<[^>]+>/g, "");
	md = md.replace(/\n{3,}/g, "\n\n");
	return md.trim();
}

function jsonResponse(data: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

function validateUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; error: string } {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return { ok: false, error: "Invalid URL" };
	}
	if (!["http:", "https:"].includes(parsed.protocol)) {
		return { ok: false, error: "Only http and https URLs supported" };
	}
	return { ok: true, url: parsed };
}

async function fetchPageMarkdown(
	env: Env,
	url: string,
	waitFor: string | undefined,
	timeoutMs: number
): Promise<{ html: string; markdown: string; title: string; finalUrl: string }> {
	const browser = await puppeteer.launch(env.MYBROWSER);
	try {
		const page = await browser.newPage();
		await page.setUserAgent(DEFAULT_UA);
		await page.goto(url, { waitUntil: "networkidle0", timeout: timeoutMs });
		if (waitFor) {
			await page.waitForSelector(waitFor, { timeout: timeoutMs });
		}
		const html = await page.content();
		const title = await page.title();
		const finalUrl = page.url();
		return { html, markdown: htmlToMarkdown(html), title, finalUrl };
	} finally {
		await browser.close();
	}
}

async function groqExtract(
	apiKey: string,
	pageMarkdown: string,
	pageTitle: string,
	pageUrl: string,
	instruction: string,
	schema?: Record<string, unknown>
): Promise<{ data: unknown; tokens_used: number; model: string }> {
	const truncated = pageMarkdown.length > 60000 ? pageMarkdown.slice(0, 60000) : pageMarkdown;

	const schemaHint = schema
		? `\n\nReturn JSON that strictly matches this schema:\n${JSON.stringify(schema, null, 2)}`
		: "\n\nReturn a JSON object with sensible field names that match the instruction.";

	const systemPrompt =
		"You are a precise structured data extraction engine. " +
		"You only return valid JSON. No prose, no explanations, no markdown code fences. " +
		"If a field cannot be found in the content, set it to null. " +
		"Never invent or hallucinate data not present in the content.";

	const userPrompt =
		`URL: ${pageUrl}\n` +
		`Page title: ${pageTitle}\n\n` +
		`Page content (markdown):\n---\n${truncated}\n---\n\n` +
		`Instruction: ${instruction}` +
		schemaHint;

	const response = await fetch(GROQ_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: GROQ_MODEL,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			],
			response_format: { type: "json_object" },
			temperature: 0.1,
			max_tokens: 2048,
		}),
	});

	if (!response.ok) {
		const errBody = await response.text();
		throw new Error(`Groq API ${response.status}: ${errBody.slice(0, 500)}`);
	}

	const result = (await response.json()) as {
		choices: { message: { content: string } }[];
		usage?: { total_tokens?: number };
		model?: string;
	};

	const content = result.choices?.[0]?.message?.content ?? "{}";
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		parsed = { raw: content, parse_error: "Model did not return valid JSON" };
	}

	return {
		data: parsed,
		tokens_used: result.usage?.total_tokens ?? 0,
		model: result.model ?? GROQ_MODEL,
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Health check
		if (request.method === "GET" && url.pathname === "/") {
			return jsonResponse({
				service: "AgentScrape",
				version: "0.2.0",
				status: "alive",
				tools: ["scrape_webpage", "extract_structured_data"],
				model: GROQ_MODEL,
			});
		}

		// Raw scrape
		if (request.method === "POST" && url.pathname === "/scrape") {
			let body: ScrapeRequest;
			try {
				body = await request.json();
			} catch {
				return jsonResponse({ error: "Invalid JSON body" }, 400);
			}

			if (!body.url) {
				return jsonResponse({ error: "Missing required field: url" }, 400);
			}

			const urlCheck = validateUrl(body.url);
			if (!urlCheck.ok) {
				return jsonResponse({ error: urlCheck.error }, 400);
			}

			const outputFormat = body.output_format ?? "markdown";
			const timeoutMs = Math.min(body.timeout_ms ?? 30000, 60000);
			const startedAt = Date.now();

			try {
				const { html, markdown, title, finalUrl } = await fetchPageMarkdown(
					env,
					body.url,
					body.wait_for,
					timeoutMs
				);

				let content: string;
				switch (outputFormat) {
					case "html":
						content = html;
						break;
					case "text":
						content = htmlToText(html);
						break;
					case "json":
						content = JSON.stringify({
							title,
							url: finalUrl,
							text: htmlToText(html),
							html_length: html.length,
						});
						break;
					case "markdown":
					default:
						content = markdown;
						break;
				}

				return jsonResponse({
					success: true,
					url: finalUrl,
					title,
					output_format: outputFormat,
					content,
					elapsed_ms: Date.now() - startedAt,
					scraped_at: new Date().toISOString(),
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResponse(
					{
						success: false,
						error: "Scrape failed",
						detail: message,
						elapsed_ms: Date.now() - startedAt,
					},
					500
				);
			}
		}

		// AI-powered extraction
		if (request.method === "POST" && url.pathname === "/extract") {
			let body: ExtractRequest;
			try {
				body = await request.json();
			} catch {
				return jsonResponse({ error: "Invalid JSON body" }, 400);
			}

			if (!body.url) {
				return jsonResponse({ error: "Missing required field: url" }, 400);
			}
			if (!body.instruction || body.instruction.trim().length === 0) {
				return jsonResponse({ error: "Missing required field: instruction" }, 400);
			}
			if (!env.GROQ_API_KEY) {
				return jsonResponse({ error: "Server misconfigured: GROQ_API_KEY missing" }, 500);
			}

			const urlCheck = validateUrl(body.url);
			if (!urlCheck.ok) {
				return jsonResponse({ error: urlCheck.error }, 400);
			}

			const timeoutMs = Math.min(body.timeout_ms ?? 30000, 60000);
			const startedAt = Date.now();

			try {
				const { markdown, title, finalUrl } = await fetchPageMarkdown(
					env,
					body.url,
					body.wait_for,
					timeoutMs
				);

				const fetchMs = Date.now() - startedAt;
				const extractionStart = Date.now();

				const { data, tokens_used, model } = await groqExtract(
					env.GROQ_API_KEY,
					markdown,
					title,
					finalUrl,
					body.instruction,
					body.schema
				);

				return jsonResponse({
					success: true,
					url: finalUrl,
					title,
					instruction: body.instruction,
					data,
					model,
					tokens_used,
					fetch_ms: fetchMs,
					extraction_ms: Date.now() - extractionStart,
					elapsed_ms: Date.now() - startedAt,
					extracted_at: new Date().toISOString(),
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResponse(
					{
						success: false,
						error: "Extraction failed",
						detail: message,
						elapsed_ms: Date.now() - startedAt,
					},
					500
				);
			}
		}

		return jsonResponse({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
