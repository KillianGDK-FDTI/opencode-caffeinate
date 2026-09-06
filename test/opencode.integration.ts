import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"

test("OpenCode loads TypeScript and tracks a real shell operation", {
  skip: process.platform !== "darwin", timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-caffeinate-"))
  const server = spawn(process.env.OPENCODE_BIN ?? "opencode", [
    "serve", "--hostname", "127.0.0.1", "--port", "0",
  ], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        plugin: [new URL("../index.ts", import.meta.url).href],
        autoupdate: false, share: "disabled", model: "openai/gpt-4o", enabled_providers: [],
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  let spawnError: Error | undefined
  server.on("error", (error) => { spawnError = error })
  server.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })
  server.stderr.on("data", (chunk: Buffer) => { output += chunk.toString() })
  function hasChild() {
    if (!server.pid) return false
    try {
      execFileSync("pgrep", ["-P", String(server.pid), "caffeinate"], { stdio: "ignore" })
      return true
    } catch { return false }
  }
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw spawnError
      if (server.exitCode !== null) throw new Error(`OpenCode exited: ${output}`)
      if (predicate()) return
      await delay(100)
    }
    assert.fail(`OpenCode condition not reached: ${output}`)
  }
  try {
    await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
    const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)![0]
    async function request(path: string, body: object) {
      const response = await fetch(url + path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      })
      assert.ok(response.ok, `${path}: ${response.status}`)
      return response.json() as Promise<{ id: string }>
    }
    const session = await request("/session", { title: "Caffeinate integration test" })
    const work = request(`/session/${session.id}/shell`, { agent: "build", command: "sleep 3" })
    void work.catch(() => {})
    await until(hasChild)
    await work
    await until(() => !hasChild())
  } finally {
    if (server.pid && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit")
      server.kill("SIGTERM")
      const kill = setTimeout(() => server.kill("SIGKILL"), 2_000)
      try { await exited } finally { clearTimeout(kill) }
    }
    await rm(root, { recursive: true, force: true })
  }
})
