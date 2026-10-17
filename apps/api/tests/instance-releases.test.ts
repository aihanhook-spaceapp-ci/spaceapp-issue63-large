import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { approveHotfix, promoteDev, readReleases, type ReleasesOptions } from "../src/instance-releases.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function ticket(id: string, status: string, summary: string) {
  return { id, status, sha: "a".repeat(40), branch: "space/wt", summary, submittedAt: "2026-10-12T10:00:00.000Z", updatedAt: "2026-10-12T10:00:00.000Z", history: [] };
}

function fixture(queueOutput = "{\"id\":\"q-20261012-100000-abcd\"}") {
  const root = mkdtempSync(join(tmpdir(), "space-releases-"));
  roots.push(root);
  const stableRepo = join(root, "stable");
  execFileSync("git", ["init", "-q", "-b", "main", stableRepo]);
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"]]) git(stableRepo, "config", key, value);
  writeFileSync(join(stableRepo, "app.txt"), "base\n");
  git(stableRepo, "add", ".");
  git(stableRepo, "commit", "-qm", "base");
  const devRepo = join(root, "dev");
  execFileSync("git", ["clone", "-q", stableRepo, devRepo]);
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"]]) git(devRepo, "config", key, value);
  git(devRepo, "checkout", "-q", "-b", "dev");
  for (const subject of ["Merge queue q-20261012-090000-aaaa: Feature A", "Merge queue q-20261012-091000-bbbb: Back-merge stable main into dev", "Merge queue q-20261012-092000-cccc: Feature B"]) {
    git(devRepo, "commit", "-q", "--allow-empty", "-m", subject);
  }
  git(devRepo, "update-ref", "refs/space-queue/live-verified", git(devRepo, "rev-parse", "HEAD"));
  git(stableRepo, "fetch", "-q", devRepo, "+dev:refs/heads/dev");
  const stableQueueRoot = join(root, "queue");
  const devQueueRoot = join(root, "queue-dev");
  for (const dir of [join(stableQueueRoot, "tickets"), join(devQueueRoot, "tickets")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(stableQueueRoot, "default-target"), "dev\n");
  writeFileSync(join(stableQueueRoot, "tickets", "q-20261012-080000-1111.json"), JSON.stringify(ticket("q-20261012-080000-1111", "DEPLOYED", "Promote dev 0123456789 to stable")));
  writeFileSync(join(stableQueueRoot, "tickets", "q-20261012-093000-2222.json"), JSON.stringify(ticket("q-20261012-093000-2222", "AWAITING_APPROVAL", "Urgent stable fix")));
  const queueScript = join(root, "fake-queue.mjs");
  writeFileSync(queueScript, `process.stdout.write(${JSON.stringify(queueOutput)});\n`);
  const options: ReleasesOptions = {
    stableRepo, devRepo, stableQueueRoot, devQueueRoot, queueScript, nodeBin: process.execPath,
    stableUrl: "https://stable.test", devUrl: "https://dev.test", managedHere: true
  };
  return { root, options, devHead: git(devRepo, "rev-parse", "HEAD") };
}

describe("instance releases", () => {
  it("lists what dev has that stable lacks, the last promotion and hotfixes waiting for approval", async () => {
    const f = fixture();
    const report = await readReleases(f.options);
    expect(report.available).toBe(true);
    expect(report.defaultTarget).toBe("dev");
    expect(report.dev).toMatchObject({ commit: f.devHead, verifiedCommit: f.devHead, url: "https://dev.test" });
    expect(report.pending.map((change) => [change.ticketId, change.summary])).toEqual([
      ["q-20261012-092000-cccc", "Feature B"],
      ["q-20261012-090000-aaaa", "Feature A"]
    ]);
    expect(report.pendingCount).toBe(2);
    expect(report.promotion?.id).toBe("q-20261012-080000-1111");
    expect(report.hotfixes.map((hotfix) => hotfix.status)).toEqual(["AWAITING_APPROVAL"]);
  });

  it("reports an unavailable dev instance without failing", async () => {
    const f = fixture();
    const report = await readReleases({ ...f.options, devRepo: join(f.root, "missing") });
    expect(report.available).toBe(false);
    expect(report.dev.commit).toBeNull();
  });

  it("queues a promotion through the merge queue and reports an already promoted dev", async () => {
    const queued = fixture();
    await expect(promoteDev(queued.options)).resolves.toMatchObject({ status: "QUEUED", ticketId: "q-20261012-100000-abcd" });
    const already = fixture("Stable already contains dev 0123456789.\n");
    await expect(promoteDev(already.options)).resolves.toMatchObject({ status: "ALREADY_LIVE", ticketId: null });
    await expect(promoteDev({ ...queued.options, managedHere: false })).rejects.toThrow(/stable instance/);
    await expect(approveHotfix("q-bad", queued.options)).rejects.toThrow(/Invalid ticket id/);
    await expect(approveHotfix("q-20261012-093000-2222", queued.options)).resolves.toMatchObject({ status: "APPROVED" });
  });

  it("lets only an ADMIN read releases and refuses promotion on the dev instance", async () => {
    const f = fixture();
    const app = await createApp({
      config: getApiConfig({ SPACE_INSTANCE: "dev" }),
      releasesOptions: f.options,
      auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false }
    });
    try {
      const anonymous = await app.inject({ method: "GET", url: "/api/admin/releases" });
      expect(anonymous.statusCode).toBe(401);
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
      const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
      const csrf = (await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } })).json().csrfToken as string;
      const report = await app.inject({ method: "GET", url: "/api/admin/releases", headers: { cookie } });
      expect(report.statusCode).toBe(200);
      expect(report.json()).toMatchObject({ managedHere: false, pendingCount: 2 });
      const promote = await app.inject({ method: "POST", url: "/api/admin/releases/promote", headers: { cookie, "x-space-csrf-token": csrf } });
      expect(promote.statusCode).toBe(409);
      expect(promote.json().message ?? JSON.stringify(promote.json())).toMatch(/stable instance/);
    } finally {
      await app.close();
    }
  });
});
