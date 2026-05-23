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
	include_screenshot?: boolean;
	include_metadata?: boolean;
}

interface ExtractRequest {
	url: string;
	instruction: string;
	schema?: Record<string, unknown>;
	wait_for?: string;
	timeout_ms?: number;
	include_screenshot?: boolean;
}

interface ScreenshotRequest {
	url: string;
	full_page?: boolean;
	viewport?: "desktop" | "mobile" | "tablet";
	wait_for?: string;
	timeout_ms?: number;
}

interface MetadataRequest {
	url: string;
	wait_for?: string;
	timeout_ms?: number;
}

interface PageMetadata {
	title: string;
	description: string | null;
	canonical: string | null;
	og: Record<string, string>;
	twitter: Record<string, string>;
	jsonld: unknown[];
	favicon: string | null;
	language: string | null;
	all_meta: Record<string, string>;
}

const GROQ_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const VIEWPORTS = {
	desktop: { width: 1920, height: 1080, isMobile: false },
	mobile: { width: 390, height: 844, isMobile: true },
	tablet: { width: 1024, height: 1366, isMobile: false },
};

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

function uint8ToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode.apply(null, Array.from(chunk));
	}
	return btoa(binary);
}

async function extractMetadataFromPage(page: any): Promise<PageMetadata> {
	return await page.evaluate(() => {
		const getMeta = (name: string): string | null => {
			const el =
				document.querySelector(`meta[name="${name}"]`) ||
				document.querySelector(`meta[property="${name}"]`);
			return el ? (el as HTMLMetaElement).content : null;
		};

		const allMeta: Record<string, string> = {};
		document.querySelectorAll("meta").forEach((m) => {
			const key = m.getAttribute("name") || m.getAttribute("property");
			const val = m.getAttribute("content");
			if (key && val) allMeta[key] = val;
		});

		const og: Record<string, string> = {};
		const twitter: Record<string, string> = {};
		for (const [k, v] of Object.entries(allMeta)) {
			if (k.startsWith("og:")) og[k.slice(3)] = v;
			if (k.startsWith("twitter:")) twitter[k.slice(8)] = v;
		}

		const jsonld: unknown[] = [];
		document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
			try {
				jsonld.push(JSON.parse(s.textContent || "{}"));
			} catch {
				/* skip invalid */
			}
		});

		const canonicalEl = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
		const faviconEl =
			(document.querySelector('link[rel="icon"]') as HTMLLinkElement | null) ||
			(document.querySelector('link[rel="shortcut icon"]') as HTMLLinkElement | null);
		const htmlEl = document.querySelector("html");

		return {
			title: document.title,
			description: getMeta("description"),
			canonical: canonicalEl ? canonicalEl.href : null,
			og,
			twitter,
			jsonld,
			favicon: faviconEl ? faviconEl.href : null,
			language: htmlEl ? htmlEl.getAttribute("lang") : null,
			all_meta: allMeta,
		};
	});
}

interface PageFetchResult {
	html: string;
	markdown: string;
	title: string;
	finalUrl: string;
	screenshot?: string;
	metadata?: PageMetadata;
}

async function fetchPage(
	env: Env,
	options: {
		url: string;
		waitFor?: string;
		timeoutMs: number;
		viewport?: "desktop" | "mobile" | "tablet";
		captureScreenshot?: boolean;
		fullPageScreenshot?: boolean;
		extractMeta?: boolean;
		extractContent?: boolean;
	}
): Promise<PageFetchResult> {
	const browser = await puppeteer.launch(env.MYBROWSER);
	try {
		const page = await browser.newPage();
		const vp = VIEWPORTS[options.viewport ?? "desktop"];
		await page.setViewport(vp);
		await page.setUserAgent(DEFAULT_UA);
		await page.goto(options.url, { waitUntil: "networkidle0", timeout: options.timeoutMs });
		if (options.waitFor) {
			await page.waitForSelector(options.waitFor, { timeout: options.timeoutMs });
		}

		const title = await page.title();
		const finalUrl = page.url();

		let html = "";
		let markdown = "";
		if (options.extractContent !== false) {
			html = await page.content();
			markdown = htmlToMarkdown(html);
		}

		let screenshot: string | undefined;
		if (options.captureScreenshot) {
			const buf = await page.screenshot({
				type: "png",
				fullPage: options.fullPageScreenshot ?? false,
			});
			screenshot = uint8ToBase64(new Uint8Array(buf));
		}

		let metadata: PageMetadata | undefined;
		if (options.extractMeta) {
			metadata = await extractMetadataFromPage(page);
		}

		return { html, markdown, title, finalUrl, screenshot, metadata };
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
				version: "0.3.0",
				status: "alive",
				tools: [
					"scrape_webpage",
					"extract_structured_data",
					"screenshot_webpage",
					"get_page_metadata",
				],
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
			if (!body.url) return jsonResponse({ error: "Missing required field: url" }, 400);

			const urlCheck = validateUrl(body.url);
			if (!urlCheck.ok) return jsonResponse({ error: urlCheck.error }, 400);

			const outputFormat = body.output_format ?? "markdown";
			const timeoutMs = Math.min(body.timeout_ms ?? 30000, 60000);
			const startedAt = Date.now();

			try {
				const result = await fetchPage(env, {
					url: body.url,
					waitFor: body.wait_for,
					timeoutMs,
					captureScreenshot: body.include_screenshot ?? false,
					extractMeta: body.include_metadata ?? false,
				});

				let content: string;
				switch (outputFormat) {
					case "html":
						content = result.html;
						break;
					case "text":
						content = htmlToText(result.html);
						break;
					case "json":
						content = JSON.stringify({
							title: result.title,
							url: result.finalUrl,
							text: htmlToText(result.html),
							html_length: result.html.length,
						});
						break;
					case "markdown":
					default:
						content = result.markdown;
						break;
				}

				const payload: Record<string, unknown> = {
					success: true,
					url: result.finalUrl,
					title: result.title,
					output_format: outputFormat,
					content,
					elapsed_ms: Date.now() - startedAt,
					scraped_at: new Date().toISOString(),
				};
				if (result.screenshot) payload.screenshot_base64 = result.screenshot;
				if (result.metadata) payload.metadata = result.metadata;

				return jsonResponse(payload);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResponse(
					{ success: false, error: "Scrape failed", detail: message, elapsed_ms: Date.now() - startedAt },
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
			if (!body.url) return jsonResponse({ error: "Missing required field: url" }, 400);
			if (!body.instruction || body.instruction.trim().length === 0)
				return jsonResponse({ error: "Missing required field: instruction" }, 400);
			if (!env.GROQ_API_KEY)
				return jsonResponse({ error: "Server misconfigured: GROQ_API_KEY missing" }, 500);

			const urlCheck = validateUrl(body.url);
			if (!urlCheck.ok) return jsonResponse({ error: urlCheck.error }, 400);

			const timeoutMs = Math.min(body.timeout_ms ?? 30000, 60000);
			const startedAt = Date.now();

			try {
				const result = await fetchPage(env, {
					url: body.url,
					waitFor: body.wait_for,
					timeoutMs,
					captureScreenshot: body.include_screenshot ?? false,
				});

				const fetchMs = Date.now() - startedAt;
				const extractionStart = Date.now();

				const { data, tokens_used, model } = await groqExtract(
					env.GROQ_API_KEY,
					result.markdown,
					result.title,
					result.finalUrl,
					body.instruction,
					body.schema
				);

				const payload: Record<string, unknown> = {
					success: true,
					url: result.finalUrl,
					title: result.title,
					instruction: body.instruction,
					data,
					model,
					tokens_used,
					fetch_ms: fetchMs,
					extraction_ms: Date.now() - extractionStart,
					elapsed_ms: Date.now() - startedAt,
					extracted_at: new Date().toISOString(),
				};
				if (result.screenshot) payload.screenshot_base64 = result.screenshot;

				return jsonResponse(payload);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResponse(
					{ success: false, error: "Extraction failed", detail: message, elapsed_ms: Date.now() - startedAt },
					500
				);
			}
		}

		// Screenshot only
		if (request.method === "POST" && url.pathname === "/screenshot") {
			let body: ScreenshotRequest;
			try {
				body = await request.json();
			} catch {
				return jsonResponse({ error: "Invalid JSON body" }, 400);
			}
			if (!body.url) return jsonResponse({ error: "Missing required field: url" }, 400);

			const urlCheck = validateUrl(body.url);
			if (!urlCheck.ok) return jsonResponse({ error: urlCheck.error }, 400);

			const timeoutMs = Math.min(body.timeout_ms ?? 30000, 60000);
			const startedAt = Date.now();

			try {
				const result = await fetchPage(env, {
					url: body.url,
					waitFor: body.wait_for,
					timeoutMs,
					viewport: body.viewport ?? "desktop",
					captureScreenshot: true,
					fullPageScreenshot: body.full_page ?? false,
					extractContent: false,
				});

				return jsonResponse({
					success: true,
					url: result.finalUrl,
					title: result.title,
					viewport: body.viewport ?? "desktop",
					full_page: body.full_page ?? false,
					screenshot_base64: result.screenshot,
					format: "png",
					elapsed_ms: Date.now() - startedAt,
					captured_at: new Date().toISOString(),
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResponse(
					{ success: false, error: "Screenshot failed", detail: message, elapsed_ms: Date.now() - startedAt },
					500
				);
			}
		}

		// Metadata only
		if (request.method === "POST" && url.pathname === "/metadata") {
			let body: MetadataRequest;
			try {
				body = await request.json();
			} catch {
				return jsonResponse({ error: "Invalid JSON body" }, 400);
			}
			if (!body.url) return jsonResponse({ error: "Missing required field: url" }, 400);

			const urlCheck = validateUrl(body.url);
			if (!urlCheck.ok) return jsonResponse({ error: urlCheck.error }, 400);

			const timeoutMs = Math.min(body.timeout_ms ?? 30000, 60000);
			const startedAt = Date.now();

			try {
				const result = await fetchPage(env, {
					url: body.url,
					waitFor: body.wait_for,
					timeoutMs,
					extractMeta: true,
					extractContent: false,
				});

				return jsonResponse({
					success: true,
					url: result.finalUrl,
					metadata: result.metadata,
					elapsed_ms: Date.now() - startedAt,
					extracted_at: new Date().toISOString(),
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResponse(
					{ success: false, error: "Metadata extraction failed", detail: message, elapsed_ms: Date.now() - startedAt },
					500
				);
			}
		}

		return jsonResponse({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
