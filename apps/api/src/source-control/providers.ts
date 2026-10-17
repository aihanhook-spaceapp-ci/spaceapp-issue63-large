import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import type { GitRemoteRepository, LegacyRepositoryProviderId, LegacyRepositoryProviderAdapter, RepositoryProviderAdapter } from "@space/contracts";
import { GitControlError } from "./errors.js";

export interface ProviderIdentity { login: string; email: string | null }
export type ProviderRequest = (url: URL, token: string, method: string, body?: unknown, scheme?: "Bearer" | "token") => Promise<unknown>;
export interface GitProviderClient extends LegacyRepositoryProviderAdapter, Partial<Omit<RepositoryProviderAdapter, keyof LegacyRepositoryProviderAdapter>> {}
export interface ProviderResponse { data: unknown; headers: Record<string, string> }
export type ProviderExchange = (url: URL, authorization: string, method: string, body?: unknown) => Promise<ProviderResponse>;

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number); const a = parts[0]!, b = parts[1]!;
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224;
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return privateAddress(normalized.slice(7));
  // Only global unicast IPv6 is eligible without an explicit installation rule.
  return !/^[23][0-9a-f]{3}:/.test(normalized);
}
export class ProviderUrlPolicy {
  constructor(private readonly allowedPrivateOrigins: string[] = []) {}
  normalize(input: string): string {
    let url: URL; try { url = new URL(input); } catch { throw new GitControlError("INVALID_SERVER", "Enter a valid provider server URL."); }
    if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new GitControlError("INVALID_SERVER", "Server URL must not contain credentials or query parameters.");
    if (url.protocol !== "https:" && !this.allowedPrivateOrigins.includes(url.origin)) throw new GitControlError("INVALID_SERVER", "HTTP providers require an explicit installation allowlist.");
    return url.toString().replace(/\/+$/, "");
  }
  async address(url: URL): Promise<{ address: string; family: number }> {
    this.normalize(url.origin);
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
    if (!addresses.length || addresses.some(a => privateAddress(a.address)) && !this.allowedPrivateOrigins.includes(url.origin)) throw new GitControlError("INVALID_SERVER", "Private provider destinations require an explicit installation allowlist.");
    return addresses[0]!;
  }
  request: ProviderRequest = async (url, token, method, body, scheme = "Bearer") =>
    (await this.exchange(url, `${scheme} ${token}`, method, body)).data;
  exchange: ProviderExchange = async (url, authorization, method, body) => {
    const address = await this.address(url);
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        // DNS is already validated and pinned to one address; do not request an address list.
        method, family: address.family, lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        headers: { authorization, accept: "application/json", "user-agent": "Space-Source-Control", ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) }
      }, response => {
        let text = "";
        response.on("data", (part: Buffer) => { text += part.toString("utf8"); if (Buffer.byteLength(text) > 4 * 1024 * 1024) request.destroy(new Error("limit")); });
        response.on("end", () => {
          const code = response.statusCode ?? 500;
          if (code >= 300 && code < 400) return reject(new GitControlError("REDIRECT_BLOCKED", "Provider redirects are not allowed.", 502));
          if (code === 401) return reject(new GitControlError("INVALID_TOKEN", "Token is invalid or expired.", 401));
          if (code === 403) return reject(new GitControlError("INSUFFICIENT_PERMISSION", "Token lacks the required repository permission.", 403));
          if (code === 404) return reject(new GitControlError("REPOSITORY_NOT_FOUND", "Repository is unavailable to this account.", 404));
          if (code === 409 || code === 422) return reject(new GitControlError("REPOSITORY_COLLISION", "Repository name is unavailable or the create request was rejected.", 409));
          if (code === 429) return reject(new GitControlError("RATE_LIMITED", "Provider rate limit reached. Retry later.", 429));
          if (code === 408) return reject(new GitControlError("PROVIDER_UNAVAILABLE", "Provider request timed out.", 503));
          // Other 4xx answers are definite refusals (for example GitLab/Bitbucket report a taken name with 400).
          if (code >= 400 && code < 500) return reject(new GitControlError("PROVIDER_REJECTED", "Provider rejected the request. Check the repository name, target and permissions.", 400));
          if (code >= 400) return reject(new GitControlError("PROVIDER_FAILED", "Provider request failed. Check repository permissions and availability.", 502));
          try {
            const headers: Record<string, string> = {};
            for (const key of ["link", "x-next-page", "x-total-count", "x-ms-continuationtoken", "retry-after"]) {
              const value = response.headers[key]; if (typeof value === "string") headers[key] = value;
            }
            resolve({ data: JSON.parse(text), headers });
          } catch { reject(new GitControlError("PROVIDER_FAILED", "Provider returned an invalid response.", 502)); }
        });
      });
      request.setTimeout(15000, () => request.destroy());
      request.on("error", () => reject(new GitControlError("PROVIDER_UNAVAILABLE", "Provider is offline or could not be reached.", 503)));
      request.end(payload);
    });
  };
}
export class ApiGitProvider implements GitProviderClient {
  private readonly server: string;
  private readonly api: string;
  constructor(readonly provider: LegacyRepositoryProviderId, serverUrl: string, private readonly token: string, private readonly policy: ProviderUrlPolicy, private readonly request: ProviderRequest = policy.request) {
    if (provider !== "github" && provider !== "gitea") throw new GitControlError("PROVIDER_NOT_AVAILABLE", "This repository provider is not available yet.", 409);
    this.server = provider === "github" ? "https://github.com" : policy.normalize(serverUrl);
    this.api = provider === "github" ? "https://api.github.com" : `${this.server}/api/v1`;
  }
  private call(path: string, method = "GET", body?: unknown) { return this.request(new URL(`${this.api}${path}`), this.token, method, body, this.provider === "gitea" ? "token" : "Bearer"); }
  async identity(): Promise<ProviderIdentity> {
    const user = await this.call("/user") as { login?: string; email?: string | null };
    if (!user.login) throw new GitControlError("INVALID_TOKEN", "Provider did not verify an account.", 401);
    return { login: user.login, email: user.email ?? null };
  }
  private map(value: unknown): GitRemoteRepository {
    const r = value as { id: string | number; full_name: string; clone_url: string; html_url: string; private: boolean; default_branch?: string; permissions?: { pull?: boolean; push?: boolean; admin?: boolean } };
    if (!r.id || !r.full_name || !r.clone_url) throw new GitControlError("PROVIDER_FAILED", "Provider returned an invalid repository.", 502);
    return { id: String(r.id), fullName: r.full_name, cloneUrl: r.clone_url, webUrl: r.html_url, private: r.private, defaultBranch: r.default_branch || "main", permissions: { pull: r.permissions?.pull ?? false, push: r.permissions?.push ?? false, admin: r.permissions?.admin ?? false } };
  }
  async repositories(page: number) {
    const result = await this.call(`/user/repos?page=${page}&${this.provider === "github" ? "per_page" : "limit"}=50&sort=updated`) as unknown[];
    if (!Array.isArray(result)) throw new GitControlError("PROVIDER_FAILED", "Provider returned an invalid repository list.", 502);
    return result.map(r => this.map(r));
  }
  async repository(fullName: string) {
    const parts = fullName.split("/");
    if (parts.length !== 2 || parts.some(p => !p || p === "." || p === "..")) throw new GitControlError("INVALID_REPOSITORY", "Invalid repository name.");
    return this.map(await this.call(`/repos/${parts.map(encodeURIComponent).join("/")}`));
  }
  async create(name: string, privateRepo: boolean) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new GitControlError("INVALID_REPOSITORY", "Invalid repository name.");
    return this.map(await this.call("/user/repos", "POST", { name, private: privateRepo, auto_init: false, default_branch: "main" }));
  }
  async validateCloneUrl(input: string) {
    let url: URL; try { url = new URL(input); } catch { throw new GitControlError("REMOTE_MISMATCH", "Only provider HTTPS clone URLs are supported."); }
    const server = new URL(this.server);
    if (url.origin !== server.origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(`${server.pathname.replace(/\/$/, "")}/`)) throw new GitControlError("REMOTE_MISMATCH", "Repository URL does not match the connected provider.", 409);
    await this.policy.address(url);
    return url.toString();
  }
}

export { createRepositoryProvider, repositoryGitLogin, repositoryServer, type RepositoryCredentials } from "./adapters/index.js";
export { createGitEnvironment, createAnonymousGitEnvironment } from "./git-credentials.js";
