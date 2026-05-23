import puppeteer from "@cloudflare/puppeteer";

interface Env {
	MYBROWSER: Fetcher;
}

interface ScrapeRequest {
	url: string;
	output_format?: "markdown" | "html" | "text" | "json";
	wait_for?: string;
	timeout_ms?: number;
}

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

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Health check
		if (request.method === "GET" && url.pathname === "/") {
			return jsonResponse({
				service: "AgentScrape",
				version: "0.1.0",
				status: "alive",
				tools: ["scrape_webpage"],
			});
		}

		// Scrape endpoint
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

			let parsedUrl: URL;
			try {
				parsedUrl = new URL(body.url);
			} catch {
				return jsonResponse({ error: "Invalid URL" }, 400);
			}

			if (!["http:", "https:"].includes(parsedUrl.protocol)) {
				return jsonResponse({ error: "Only http and https URLs supported" }, 400);
			}

			const outputFormat = body.output_format ?? "markdown";
			const timeoutMs = Math.min(body.timeout_ms ?? 30000, 60000);
			const startedAt = Date.now();

			let browser;
			try {
				browser = await puppeteer.launch(env.MYBROWSER);
				const page = await browser.newPage();
				await page.setUserAgent(
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
				);

				await page.goto(body.url, {
					waitUntil: "networkidle0",
					timeout: timeoutMs,
				});

				if (body.wait_for) {
					await page.waitForSelector(body.wait_for, { timeout: timeoutMs });
				}

				const html = await page.content();
				const title = await page.title();
				const finalUrl = page.url();

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
						content = htmlToMarkdown(html);
						break;
				}

				const elapsedMs = Date.now() - startedAt;

				return jsonResponse({
					success: true,
					url: finalUrl,
					title,
					output_format: outputFormat,
					content,
					elapsed_ms: elapsedMs,
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
			} finally {
				if (browser) {
					await browser.close();
				}
			}
		}

		return jsonResponse({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
