import { T3AssetHandles, T3GatewayError, type T3HandleScope } from "./gateway-policy.js";

// Space manages the T3 runtime, pairing, the CLIs it provides and provider
// sign-in: providers use the accounts signed in once in Space, so sign-in,
// sign-out and ChatGPT handoff inside T3 are refused (provider.auth.subscribe
// stays readable for status). T3's own pinned, hash-verified installs remain.
const denied = /^(?:auth\.|cloud\.|devices?\.|server\.(?:updateServer|updateServerWithProgress|commitDesktopUpdate|signalProcess|updateProvider)|provider\.(?:auth\.(?!subscribe$)|chatgpt\.))/;
type Message = Record<string, any>;
function messages(raw: string): { batch: boolean; messages: Message[] } {
  const value: unknown = JSON.parse(raw);
  const list = Array.isArray(value) ? value : [value];
  if (list.length > 128 || !list.every(item => item && typeof item === "object" && typeof item._tag === "string")) throw new T3GatewayError(400, "T3_RPC_INVALID");
  return { batch: Array.isArray(value), messages: list };
}

// Only the two pinned RPC schemas returning signed URLs are transformed.
// Arbitrary text, files, and stream chunks are never searched or rewritten.
export class T3RpcBoundary {
  private readonly pending = new Map<string, string>();
  constructor(private readonly handles: T3AssetHandles, private readonly scope: T3HandleScope) {}
  client(raw: string, reject: (response: string) => void = () => {}): string | null {
    const parsed = messages(raw);
    const forwarded: Message[] = [];
    for (const message of parsed.messages) {
      if (message._tag !== "Request") {
        if (!["Ack", "Interrupt", "Ping", "Eof"].includes(message._tag)) throw new T3GatewayError(400, "T3_RPC_INVALID");
        forwarded.push(message);
        continue;
      }
      const id = String(message.id);
      if (!["string", "number"].includes(typeof message.id) || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || typeof message.tag !== "string" ||
          this.pending.has(id) || this.pending.size >= 1024 || message.isNotification) throw new T3GatewayError(403, "T3_RPC_REJECTED");
      if (denied.test(message.tag)) {
        reject(JSON.stringify({ _tag: "Exit", requestId: message.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: {
          _tag: "EnvironmentAuthorizationError", message: "This operation is managed by Space.", requiredScope: "access:write",
        } }] } }));
        continue;
      }
      this.pending.set(id, message.tag);
      // Request-level auth comes from the verified upgrade, never RPC headers.
      message.headers = [];
      forwarded.push(message);
    }
    return forwarded.length ? JSON.stringify(parsed.batch ? forwarded : forwarded[0]) : null;
  }
  server(raw: string): string {
    const parsed = messages(raw); let changed = false;
    for (const message of parsed.messages) {
      if (message._tag !== "Exit") continue;
      const id = String(message.requestId), method = this.pending.get(id);
      this.pending.delete(id);
      if (method !== "assets.createUrl" && method !== "attachments.createUploadUrl") continue;
      if (message.exit?._tag !== "Success") continue;
      const value = message.exit.value;
      if (!value || typeof value.relativeUrl !== "string" || typeof value.expiresAt !== "number") throw new T3GatewayError(502, "T3_ASSET_INVALID");
      value.relativeUrl = this.handles.issue(this.scope, value.relativeUrl, value.expiresAt,
        method === "assets.createUrl" ? "read" : "upload").slice(1);
      changed = true;
    }
    return changed ? JSON.stringify(parsed.batch ? parsed.messages : parsed.messages[0]) : raw;
  }
}
