/**
 * Watches a Code Assist `streamGenerateContent?alt=sse` stream (bytes pass through unchanged): when content starts,
 * the usage it reports and an error reported inside the stream before any content.
 */
export interface GeminiUsage {
  promptTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  thoughtsTokens: number | null;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null);

export function readGeminiUsage(response: Json | null): GeminiUsage | null {
  const usage = obj(response?.usageMetadata);
  if (!usage) return null;
  return { promptTokens: count(usage.promptTokenCount), cachedTokens: count(usage.cachedContentTokenCount),
    outputTokens: count(usage.candidatesTokenCount), thoughtsTokens: count(usage.thoughtsTokenCount) };
}

export class CodeAssistStreamInspector {
  private buffer = "";
  private decoder = new TextDecoder();
  outputStarted = false;
  model: string | null = null;
  usage: GeminiUsage | null = null;
  finished = false;
  errorStatus: number | null = null;
  errorMessage: string | null = null;

  /** Returns true for the chunk that carries the first content. */
  push(chunk: Uint8Array): boolean {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let startedNow = false;
    for (;;) {
      const boundary = this.buffer.search(/\r?\n\r?\n/);
      if (boundary < 0) break;
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      let event: Json | null = null;
      try { event = obj(JSON.parse(data)); } catch { continue; }
      if (!event) continue;
      const error = obj(event.error);
      if (error) {
        this.errorStatus = count(error.code) ?? 500;
        this.errorMessage = typeof error.message === "string" ? error.message : null;
        continue;
      }
      const response = obj(event.response) ?? event;
      if (typeof response.modelVersion === "string") this.model = response.modelVersion;
      this.usage = readGeminiUsage(response) ?? this.usage;
      const candidates = Array.isArray(response.candidates) ? response.candidates.map(obj) : [];
      if (candidates.some((candidate) => typeof candidate?.finishReason === "string")) this.finished = true;
      const hasContent = candidates.some((candidate) => Array.isArray(obj(candidate?.content)?.parts) && (obj(candidate?.content)!.parts as unknown[]).length > 0);
      if (hasContent && !this.outputStarted) {
        this.outputStarted = true;
        startedNow = true;
      }
    }
    if (this.buffer.length > 8 * 1024 * 1024) this.buffer = this.buffer.slice(-1024 * 1024);
    return startedNow;
  }
}

/** "Individual quota reached ... Resets in 4h3m17s." -> seconds until the quota resets. */
export function parseResetsIn(message: string | null | undefined): number | null {
  const match = /resets? in ((?:\d+\s*[hms]\s*)+)/i.exec(message ?? "");
  if (!match) return null;
  let seconds = 0;
  for (const part of match[1]!.matchAll(/(\d+)\s*([hms])/gi)) {
    seconds += Number(part[1]) * (part[2]!.toLowerCase() === "h" ? 3600 : part[2]!.toLowerCase() === "m" ? 60 : 1);
  }
  return seconds > 0 ? seconds : null;
}
