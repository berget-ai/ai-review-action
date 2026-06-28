import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const apiKey = process.env.BERGET_API_KEY || process.env.AI_REVIEW_API_KEY || "";
  const baseUrl = process.env.AI_REVIEW_API_BASE || "https://api.berget.ai/v1";
  const scrapeUrl = baseUrl.replace(/\/$/, "") + "/firecrawl/scrape";

  if (!apiKey) return;

  pi.registerTool({
    name: "web_crawl",
    description:
      "Fetch a web page and return its content as markdown. Use for verifying external documentation, library APIs, CLI flags, or parameters cited in the PR. Always try your internal knowledge first — only use this tool when uncertain.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full URL to fetch (e.g. https://kubernetes.io/docs/...)",
        },
      },
      required: ["url"],
    },
    async execute({ url }: { url: string }) {
      const res = await fetch(scrapeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ url, formats: ["markdown"] }),
      });

      if (!res.ok) {
        const text = await res.text();
        return {
          content: [{ type: "text", text: `Fetch failed (${res.status}): ${text}` }],
          isError: true,
        };
      }

      const data = await res.json();
      const markdown = data?.data?.markdown ?? "(no content returned)";
      const title = data?.data?.metadata?.title ?? "";
      const truncated =
        markdown.length > 20000
          ? markdown.slice(0, 20000) + "\n\n... (truncated)"
          : markdown;

      return {
        content: [
          {
            type: "text",
            text: title ? `# ${title}\n\n${truncated}` : truncated,
          },
        ],
      };
    },
  });
}
