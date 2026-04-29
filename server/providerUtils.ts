import { createParser, EventSourceMessage } from "eventsource-parser";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import promptManager from "../engine/promptManager";
import { logger } from "../src/runtime/logger";
import * as modelCatalog from "../src/providers/modelCatalog";
import {
  describeTlsFailure,
  shouldAllowInsecureTls,
} from "../src/runtime/tls";

import axios from "axios";

const MAX_FILE_CHARS = 12000;
const MAX_TREE_ENTRIES = 200;

type ToolDefinition = Record<string, unknown>;

type GenericMessage = {
  role: string;
  content: unknown;
};

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function sanitizeModelName(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") {
    return undefined;
  }
  return trimmed;
}

function normalizeWebTarget(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    return new URL(trimmed).toString();
  } catch {
    try {
      return new URL(`http://${trimmed}`).toString();
    } catch {
      return null;
    }
  }
}

function buildProviderUrl(provider: string, baseUrl: string): string {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl);

  if (provider === "anthropic") {
    return normalizedBaseUrl.endsWith("/v1")
      ? `${normalizedBaseUrl}/messages`
      : `${normalizedBaseUrl}/v1/messages`;
  }

  return `${normalizedBaseUrl}/chat/completions`;
}

function formatToolCall(
  name: string,
  args: unknown,
  id?: string | number,
): string {
  const serializedArgs =
    typeof args === "string" ? args : JSON.stringify(args ?? {});
  const idSuffix = id !== undefined ? ` ID:${String(id)}` : "";
  return `[Tool Call] ${name}(${serializedArgs})${idSuffix}`;
}

function extractTextFragment(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => extractTextFragment(item)).join("");
  }

  if (!value || typeof value !== "object") return "";

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.text === "string") return candidate.text;
  if (typeof candidate.input_text === "string") return candidate.input_text;

  if (candidate.type === "tool_use" && typeof candidate.name === "string") {
    return formatToolCall(
      candidate.name,
      candidate.input ?? {},
      candidate.id as string | number | undefined,
    );
  }

  if (Array.isArray(candidate.parts)) {
    return candidate.parts.map((part) => extractTextFragment(part)).join("");
  }

  if (Array.isArray(candidate.content)) {
    return candidate.content.map((part) => extractTextFragment(part)).join("");
  }

  return "";
}

function normalizeTextContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return content;

  try {
    const maybeToolCall = JSON.parse(trimmed) as Record<string, unknown>;
    const toolName = maybeToolCall.tool_name || maybeToolCall.tool;
    if (typeof toolName === "string" && maybeToolCall.arguments) {
      return formatToolCall(toolName, maybeToolCall.arguments);
    }
  } catch {
    return content;
  }

  return content;
}

function normalizeChunkContent(value: unknown): string {
  const text = extractTextFragment(value);
  return text ? normalizeTextContent(text) : "";
}

function extractToolCalls(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";

  return toolCalls
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== "object") return "";

      const candidate = toolCall as Record<string, unknown>;
      const fn = candidate.function as Record<string, unknown> | undefined;
      const name =
        (typeof fn?.name === "string" && fn.name) ||
        (typeof candidate.name === "string" ? candidate.name : "");
      const args =
        fn?.arguments ??
        (candidate.arguments as unknown) ??
        (candidate.input as unknown) ??
        {};

      if (!name) return "";
      return formatToolCall(
        name,
        args,
        (candidate.id as string | number | undefined) ??
          (candidate.index as string | number | undefined),
      );
    })
    .filter(Boolean)
    .join("\n");
}

function buildRequestBody(
  provider: string,
  model: string,
  messages: GenericMessage[],
  tools: ToolDefinition[],
  stream: boolean,
): Record<string, unknown> {
  if (provider === "anthropic") {
    const anthropicMessages = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "tool" ? "user" : message.role,
        content:
          typeof message.content === "string"
            ? message.content
            : extractTextFragment(message.content),
      }));

    const systemPrompt = messages
      .filter((message) => message.role === "system")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : extractTextFragment(message.content),
      )
      .filter(Boolean)
      .join("\n\n");

    const body: Record<string, unknown> = {
      model,
      stream,
      max_tokens: 8192,
      messages: anthropicMessages,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (tools.length > 0) {
      body.tools = tools
        .map((tool) => {
          const fn =
            (tool.function as Record<string, unknown> | undefined) ?? tool;
          const name =
            typeof fn.name === "string"
              ? fn.name
              : typeof tool.name === "string"
                ? tool.name
                : "";
          if (!name) return null;

          return {
            name,
            description:
              typeof fn.description === "string" ? fn.description : "",
            input_schema:
              (fn.parameters as Record<string, unknown> | undefined) ??
              (tool.input_schema as Record<string, unknown> | undefined) ?? {
                type: "object",
                properties: {},
              },
          };
        })
        .filter(Boolean);
      body.tool_choice = { type: "auto" };
    }

    return body;
  }

  const body: Record<string, unknown> = {
    model,
    stream,
    messages,
  };

  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  if (stream && provider !== "anthropic") {
    body.stream_options = { include_usage: true };
  }

  return body;
}

export function parseGitHubUrl(input: string): GitHubMetadata {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return {
      owner: input,
      repo: input,
      branch: null,
      type: "query",
      path: "",
      url: input,
      private: false,
    };
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname !== "github.com" || parts.length < 2) {
    return {
      owner: url.hostname,
      repo: url.hostname,
      branch: null,
      type: "website",
      path: "",
      url: input,
      private: false,
    };
  }

  return {
    owner: parts[0],
    repo: parts[1],
    branch: parts[3] || null,
    type:
      parts[2] === "blob"
        ? "file"
        : parts[2] === "tree"
          ? "directory"
          : "repository",
    path: parts.slice(4).join("/"),
    url: input,
    private: false,
  };
}

export async function inspectTarget(
  urlStr: string,
  browserVisible?: boolean,
): Promise<GitHubContext> {
  const meta = parseGitHubUrl(urlStr);

  if (
    meta.type === "repository" ||
    meta.type === "directory" ||
    meta.type === "file"
  ) {
    // Basic Mock for Github inspection (can be expanded with Octokit)
    const apiUrl = `https://api.github.com/repos/${meta.owner}/${meta.repo}/contents/${meta.path}`;
    const res = await axios.get(apiUrl, {
      headers: process.env.GITHUB_TOKEN
        ? { Authorization: `token ${process.env.GITHUB_TOKEN}` }
        : {},
      validateStatus: () => true,
    });

    if (res.status !== 200) {
      throw new Error(`Failed to fetch from GitHub: ${res.statusText}`);
    }

    const data = res.data;
    if (Array.isArray(data)) {
      const tree = data.slice(0, MAX_TREE_ENTRIES).map((item: any) => ({
        path: item.path,
        type: item.type,
        size: item.size,
      }));
      return { metadata: meta, tree };
    } else {
      const content = Buffer.from(data.content, "base64").toString("utf-8");
      return {
        metadata: meta,
        file: {
          path: data.path,
          size: data.size,
          content: content.slice(0, MAX_FILE_CHARS),
        },
      };
    }
  } else {
    const normalizedUrl = normalizeWebTarget(urlStr);
    if (!normalizedUrl) {
      return {
        metadata: {
          owner: meta.owner,
          repo: meta.repo,
          branch: null,
          type: "query",
          path: meta.path,
          url: urlStr,
          private: false,
          description: "Free-form target input",
        },
        file: {
          path: "target.txt",
          size: urlStr.length,
          content: `Target Input: ${urlStr}\nDescription: Free-form target input awaiting normalization.`,
        },
      };
    }

    const host = new URL(normalizedUrl).hostname;
    return {
      metadata: {
        owner: host,
        repo: host,
        branch: "live",
        type: "website",
        path: normalizedUrl,
        url: normalizedUrl,
        private: false,
        description: "Security assessment target",
      },
      file: {
        path: "index.html",
        size: 0,
        content: `Website: ${host}\nDescription: Security assessment target\nScripts: 0 detected.`,
      },
    };
  }
}

export interface GitHubMetadata {
  owner: string;
  repo: string;
  branch: string | null;
  type: "repository" | "file" | "directory" | "website" | "query";
  path: string;
  url: string;
  private: boolean;
  description?: string;
}

export interface TreeItem {
  path: string;
  type: string;
  size: number | null;
}

export interface GitHubContext {
  metadata: GitHubMetadata;
  tree?: TreeItem[];
  file?: {
    path: string;
    size: number;
    content: string;
  };
}

export interface AnalysisPayload {
  url?: string;
  githubContext?: GitHubContext;
  goal?: string;
  outputStyle?: string;
  language?: string;
  extraContext?: string;
  provider?: string;
  model?: string;
  stream?: boolean;
  apiKey?: string;
  baseUrl?: string;
  messages?: GenericMessage[];
  tools?: ToolDefinition[];
}

export function buildAnalysisPrompt(payload: AnalysisPayload): string {
  const { githubContext, goal, outputStyle, language, extraContext, url } =
    payload;
  const fallbackUrl = normalizeWebTarget(url || "") || url || "unknown";
  const metadata =
    githubContext?.metadata ||
    parseGitHubUrl(fallbackUrl) || {
      owner: "unknown",
      repo: "unknown",
      branch: null,
      type: "query" as const,
      path: "",
      url: fallbackUrl,
      private: false,
    };
  const file = githubContext?.file;
  const tree = githubContext?.tree;

  const stylePrompt = promptManager.getPrompt(outputStyle || "blueprint");
  const lang = language || "Thai";

  let prompt = `${stylePrompt}\n\n`;
  prompt += `TARGET: ${metadata.owner}/${metadata.repo}\n`;
  prompt += `URL: ${metadata.url}\n`;
  prompt += `GOAL: ${goal || "Conduct full security audit and tactical summary."}\n`;
  prompt += `LANGUAGE: ${lang}\n\n`;

  if (extraContext) {
    prompt += `MISSION CONTEXT:\n${extraContext}\n\n`;
  }

  if (file) {
    prompt += `ENTRY POINT: ${file.path}\n\`\`\`\n${file.content}\n\`\`\`\n\n`;
  }

  if (tree && tree.length > 0) {
    prompt += `REPOSITORY STRUCTURE:\n${tree.map((t: any) => `- ${t.path} (${t.type})`).join("\n")}\n\n`;
  }

  prompt += `Execute deep analysis and provide tactical intelligence.`;
  return prompt;
}

function extractContentFromEvent(parsed: any): string {
  if (!parsed || typeof parsed !== "object") return "";

  const delta = parsed.choices?.[0]?.delta || parsed.delta;
  const message = parsed.choices?.[0]?.message || parsed.message;

  if (delta) {
    const deltaToolCalls = extractToolCalls(delta.tool_calls);
    if (deltaToolCalls) return deltaToolCalls;

    const deltaContent = normalizeChunkContent(delta.content);
    if (deltaContent) return deltaContent;

    if (typeof delta.text === "string") return normalizeTextContent(delta.text);
  }

  if (message) {
    const messageContent = normalizeChunkContent(message.content);
    if (messageContent) return messageContent;

    const messageToolCalls = extractToolCalls(message.tool_calls);
    if (messageToolCalls) return messageToolCalls;
  }

  const rootToolCalls = extractToolCalls(parsed.tool_calls);
  if (rootToolCalls) return rootToolCalls;

  if (typeof parsed.text === "string") return normalizeTextContent(parsed.text);
  if (typeof parsed.content === "string")
    return normalizeTextContent(parsed.content);
  const parsedContent = normalizeChunkContent(parsed.content);
  if (parsedContent) return parsedContent;

  // Handle KiloCode custom tool format { tool/tool_name, arguments }
  const toolName = parsed.tool_name || parsed.tool;
  if (toolName && parsed.arguments) {
    return `[Tool Call] ${toolName}(${JSON.stringify(parsed.arguments)})`;
  }

  return "";
}

export async function analyzeWithProvider(
  payload: AnalysisPayload,
  onChunk?: (c: string) => void,
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void,
) {
  const providers = modelCatalog.loadProviders();
  const provider = (payload.provider || "openai").toLowerCase();
  const providerConfig = providers[provider] || providers["openai"];

  if (!providerConfig)
    throw new Error(`Provider not supported: ${payload.provider}`);

  const apiKey = payload.apiKey || process.env[providerConfig.env_key];
  const baseUrl =
    payload.baseUrl ||
    process.env[`${provider.toUpperCase()}_BASE_URL`] ||
    providerConfig.baseUrl;
  const model =
    sanitizeModelName(payload.model) ||
    sanitizeModelName(process.env[`${provider.toUpperCase()}_MODEL`]) ||
    sanitizeModelName(providerConfig.model) ||
    "gpt-4o-mini";
  const url = buildProviderUrl(provider, baseUrl);

  const isStream = !!onChunk;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (provider === "anthropic") {
    headers["x-api-key"] = apiKey || "";
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const providerTimeout = providerConfig.timeout || 120_000;
  const retryLimit = providerConfig.retryLimit || 2;
  const allowInsecureTls = shouldAllowInsecureTls(provider, baseUrl);

  const finalMessages: GenericMessage[] = payload.messages || [
    { role: "user", content: buildAnalysisPrompt(payload) },
  ];
  const finalTools = payload.tools || [];

  const makeRequest = async (streamMode: boolean) => {
    const body = buildRequestBody(
      provider,
      model,
      finalMessages,
      finalTools,
      streamMode,
    );

    return await axios.post(url, body, {
      headers,
      timeout: providerTimeout,
      responseType: streamMode ? "stream" : "json",
      validateStatus: () => true,
      // @ts-ignore
      httpsAgent: allowInsecureTls ? new (require("https").Agent)({ rejectUnauthorized: false }) : undefined,
    });
  };

  let response: any = null;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retryLimit; attempt++) {
    try {
      response = await makeRequest(isStream);
      if (response.status === 200) break;

      const errorData = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
      let errorMsg = errorData.slice(0, 500);
      
      const lowerMsg = errorMsg.toLowerCase();
      if (response.status === 402 || lowerMsg.includes("balance") || lowerMsg.includes("insufficient") || lowerMsg.includes("credits") || lowerMsg.includes("funds")) {
        errorMsg = `[CRITICAL_BALANCE_ERROR] Insufficient API balance/credits detected. Tactical advice: Use 'list_tactical_models' to find a [FREE] alternative and 'switch_tactical_model' to continue the mission. Raw Error: ${errorMsg}`;
      }

      lastError = new Error(
        `Provider request failed (${response.status}): ${errorMsg}`,
      );

      if (response.status !== 429 && response.status < 500) break;
    } catch (e: any) {
      lastError = new Error(describeTlsFailure(e, provider));
      if (attempt < retryLimit)
        await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

  if (!response || response.status !== 200) {
    throw (
      lastError ||
      new Error(`Failed to connect to ${provider} after ${retryLimit} attempts`)
    );
  }

  const handleNonStream = async (): Promise<{
    provider: string;
    model: string;
    text: string;
  }> => {
    logger.warn(
      { provider, model },
      "Stream interrupted. Attempting non-streaming fallback...",
    );
    let fallbackResponse: any = null;
    let fallbackError: Error | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const fallbackBody: any = {
          ...buildRequestBody(provider, model, finalMessages, finalTools, false),
        };

        fallbackResponse = await axios.post(url, fallbackBody, {
          headers,
          timeout: 180_000,
          responseType: "json",
          validateStatus: () => true,
        });

        if (fallbackResponse.status === 200) break;
        fallbackError = new Error(
          `Fallback failed (${fallbackResponse.status}): ${JSON.stringify(fallbackResponse.data).slice(0, 500)}`,
        );
      } catch (e: any) {
        fallbackError = new Error(describeTlsFailure(e, provider));
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (!fallbackResponse || fallbackResponse.status !== 200) {
      throw new Error(
        `[CRITICAL] Both initial stream and non-stream fallback failed. Final error: ${fallbackError?.message}`,
      );
    }
    const fallbackData = fallbackResponse.data;
    const fallbackText =
      extractContentFromEvent(fallbackData) ||
      fallbackData.choices?.[0]?.message?.content ||
      fallbackData.content?.[0]?.text ||
      "";
    return { provider, model, text: fallbackText };
  };

  if (isStream && !response.data) {
    return await handleNonStream();
  }

  if (isStream && response.data) {
    try {
      let streamedText = "";
      let deliveredText = "";
      let hasDeliveredContent = false;
      const aggregatedToolCalls: Record<number, { id: string, name: string, args: string }> = {};

      const parser = createParser({
        onEvent(event: EventSourceMessage) {
          if (event.data === "[DONE]") return;

          let payloadText = event.data;
          let content = "";

          try {
            const parsed = JSON.parse(payloadText);
            const delta = parsed.choices?.[0]?.delta || parsed.delta;
            
            if (delta && delta.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const index = tc.index ?? 0;
                if (!aggregatedToolCalls[index]) {
                  aggregatedToolCalls[index] = {
                    id: tc.id || "",
                    name: tc.function?.name || "",
                    args: tc.function?.arguments || "",
                  };
                } else {
                  if (tc.id) aggregatedToolCalls[index].id = tc.id;
                  if (tc.function?.name) aggregatedToolCalls[index].name += tc.function.name;
                  if (tc.function?.arguments) aggregatedToolCalls[index].args += tc.function.arguments;
                }
              }
            } else {
              content = extractContentFromEvent(parsed);
            }
            
            if (parsed.usage) {
              onUsage?.(parsed.usage);
            }
          } catch {
            if (typeof payloadText === "string") {
              content = payloadText;
            }
          }

          if (content) {
            hasDeliveredContent = true;
            deliveredText += content;
            onChunk!(content);
          }
        },
      });

      // Axios stream is a node Readable stream
      try {
        for await (const chunk of response.data) {
          const chunkStr = chunk.toString();
          fs.appendFileSync(path.join(os.homedir(), ".redrock", "stream_debug.log"), chunkStr + "\\n");
          streamedText += chunkStr;
          parser.feed(chunkStr);
        }
        
        // After stream completes, append aggregated tool calls
        for (const index of Object.keys(aggregatedToolCalls).map(Number).sort((a,b)=>a-b)) {
           const tc = aggregatedToolCalls[index];
           if (tc.name) {
             const idSuffix = tc.id ? ` ID:${tc.id}` : "";
             const formatted = `\n[Tool Call] ${tc.name}(${tc.args})${idSuffix}\n`;
             hasDeliveredContent = true;
             deliveredText += formatted;
             onChunk!(formatted);
           }
        }
      } catch (streamError: any) {
        logger.warn(
          { error: streamError.message, provider, model },
          "Axios stream interrupted. Recovering via non-stream fallback...",
        );
        if (!hasDeliveredContent) {
          return await handleNonStream();
        }
        // If we have some content, just return what we got
        return { provider, model, text: deliveredText };
      }

      if (!hasDeliveredContent) {
        return await handleNonStream();
      }

      return { provider, model, text: deliveredText };
    } catch (error: any) {
      logger.error(
        { error: error.message, provider, model },
        "Critical provider error. Attempting final fallback...",
      );
      const fallbackResult = await handleNonStream();
      if (fallbackResult.text) {
        onChunk?.(fallbackResult.text);
      }
      return fallbackResult;
    }
  }

  const data = response.data;
  const text =
    extractContentFromEvent(data) ||
    data.choices?.[0]?.message?.content ||
    data.content?.[0]?.text ||
    "";
  return {
    provider,
    model,
    text,
  };
}
