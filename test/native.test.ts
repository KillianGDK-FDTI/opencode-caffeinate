import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import type { PluginInput } from "@opencode-ai/plugin"
import plugin from "../index.ts"
import { status } from "./events.ts"

const macOS = { skip: process.platform !== "darwin", timeout: 10_000 }
function children(pid: number): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(pid), "caffeinate"], { encoding: "utf8" })
      .trim().split("\n").map(Number)
  } catch {
    return []
  }
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await delay(25)
  }
  assert.fail("Native process condition did not become true")
}

test("native assertion starts, leaves display sleep alone, and is released", macOS, async () => {
  const client = { app: { log: async () => {} } } as unknown as PluginInput["client"]
  const hooks = await plugin({ client })
  assert.ok(hooks.event && hooks.dispose)
  try {
    await hooks.event({ event: status("native") })
    await until(() => children(process.pid).length === 1)
    const pid = children(process.pid)[0]!
    await until(() => execFileSync("pmset", ["-g", "assertions"], { encoding: "utf8" })
      .split("\n").some((line) => line.includes(`pid ${pid}(caffeinate)`)
        && line.includes("PreventUserIdleSystemSleep")))
    const assertions = execFileSync("pmset", ["-g", "assertions"], { encoding: "utf8" })
      .split("\n").filter((line) => line.includes(`pid ${pid}(caffeinate)`))
    assert.ok(assertions.every((line) => !line.includes("PreventUserIdleDisplaySleep")))
    await hooks.event({ event: status("native", "idle") })
    await until(() => children(process.pid).length === 0)
  } finally {
    await hooks.dispose()
  }
})

test("SIGKILL of the owner releases its caffeinate child", macOS, async () => {
  const url = new URL("../index.ts", import.meta.url).href
  const owner = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import plugin from ${JSON.stringify(url)};
    const hooks = await plugin({ client: { app: { log: async () => {} } } });
    await hooks.event({event:{type:"session.status",properties:{sessionID:"crash",status:{type:"busy"}}}});
    setInterval(() => {}, 1000);
  `], { stdio: "ignore" })
  let pid: number | undefined
  try {
    assert.ok(owner.pid)
    await until(() => children(owner.pid!).length === 1)
    pid = children(owner.pid)[0]!
    owner.kill("SIGKILL")
    await once(owner, "exit")
    await until(() => {
      try { process.kill(pid!, 0); return false } catch { return true }
    })
  } finally {
    owner.kill("SIGKILL")
  }
})

test("native timeout expires while the watched owner remains alive", macOS, async () => {
  const child = spawn("/usr/bin/caffeinate", ["-i", "-t", "1", "-w", String(process.pid)], {
    stdio: "ignore",
  })
  try {
    const [code] = await once(child, "exit")
    assert.equal(code, 0)
  } finally {
    child.kill()
  }
})
