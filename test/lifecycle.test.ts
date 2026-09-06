import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { setImmediate as flush } from "node:timers/promises"
import { mock, test, type TestContext } from "node:test"
import type { PluginInput } from "@opencode-ai/plugin"
import type { SessionStatus } from "@opencode-ai/sdk/v2"
import { ask, status, tool } from "./events.ts"

class Child extends EventEmitter {
  killed = false
  kill() {
    if (!this.killed) {
      this.killed = true
      queueMicrotask(() => this.emit("exit", 0))
    }
    return true
  }
  unref() {}
}

let spawned: { child: Child; args: string[] }[] = []
let failSpawn = false
mock.module("node:child_process", {
  namedExports: {
    spawn(command: string, args: string[], options: object) {
      assert.equal(command, "/usr/bin/caffeinate")
      assert.deepEqual(options, { stdio: "ignore" })
      const child = new Child()
      spawned.push({ child, args })
      const fail = failSpawn
      queueMicrotask(() => child.emit(fail ? "error" : "spawn", ...(fail ? [new Error("spawn failed")] : [])))
      return child
    },
  },
})
const { default: plugin } = await import("../index.ts")

async function setup(t: TestContext, maxSeconds = 600) {
  spawned = []
  failSpawn = false
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { value: "darwin" })
  t.after(() => Object.defineProperty(process, "platform", platform))
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  let now = 0
  t.mock.method(performance, "now", () => now)
  let statuses: Record<string, SessionStatus> = { a: { type: "busy" } }
  let failure = false
  let fetchStatus = async () => {
    if (failure) throw new Error("offline")
    return { data: statuses }
  }
  const logs: unknown[] = []
  const client = {
    app: { log: async (entry: unknown) => { logs.push(entry) } },
    session: { status: () => fetchStatus() },
  } as unknown as PluginInput["client"]
  const hooks = await plugin({ client }, { maxSeconds })
  assert.ok(hooks.event && hooks.dispose)
  const send = hooks.event
  const dispose = hooks.dispose
  t.after(dispose)
  const tick = async (ms: number) => {
    now += ms
    t.mock.timers.tick(ms)
    await flush()
  }
  return {
    send: async (event: Parameters<typeof send>[0]["event"]) => { await send({ event }) },
    dispose, tick, logs, client,
    fail: () => { failure = true },
    idle: () => { statuses = {} },
    deferStatus: (fn: typeof fetchStatus) => { fetchStatus = fn },
    alive: () => spawned.filter(({ child }) => !child.killed),
  }
}

test("starts asynchronously, deduplicates, and stops only owned processes", async (t) => {
  const h = await setup(t)
  await h.send(status("a"))
  assert.equal(spawned.length, 0)
  await flush()
  assert.equal(h.alive().length, 1)
  assert.deepEqual(spawned[0]!.args, ["-i", "-t", "300", "-w", String(process.pid)])
  await h.send(status("a"))
  await flush()
  assert.equal(spawned.length, 1)
  await h.send(status("a", "idle"))
  assert.equal(h.alive().length, 0)
})

test("parallel tools stay protected when a permission is pending", async (t) => {
  const h = await setup(t)
  await h.send(status("a"))
  await h.send(tool("a", "blocked"))
  await h.send(tool("a", "working"))
  await h.send(ask("a", "request", "blocked", "permission"))
  await flush()
  assert.equal(h.alive().length, 1)
  await h.send(tool("a", "working", "completed"))
  assert.equal(h.alive().length, 0)
})

test("renews with overlap and no accumulated children", async (t) => {
  const h = await setup(t)
  await h.send(status("a"))
  await flush()
  const old = spawned[0]!.child
  await h.tick(60_000)
  await h.tick(120_000)
  assert.equal(spawned.length, 2)
  assert.equal(old.killed, true)
  assert.equal(h.alive().length, 1)
})

test("failed health check does not renew a lease", async (t) => {
  const h = await setup(t)
  await h.send(status("a"))
  await flush()
  h.fail()
  await h.tick(180_000)
  assert.equal(spawned.length, 1)
})

test("polling repairs a missed idle event", async (t) => {
  const h = await setup(t)
  await h.send(status("a"))
  await flush()
  h.idle()
  await h.tick(60_000)
  assert.equal(h.alive().length, 1)
  await h.tick(60_000)
  assert.equal(h.alive().length, 0)
})

test("stale status response cannot resurrect an idle session", async (t) => {
  const h = await setup(t)
  await h.send(status("a"))
  await flush()
  const response = Promise.withResolvers<{ data: Record<string, SessionStatus> }>()
  h.deferStatus(() => response.promise)
  await h.tick(60_000)
  await h.send(status("a", "idle"))
  response.resolve({ data: { a: { type: "busy" } } })
  await flush()
  assert.equal(h.alive().length, 0)
  assert.equal(spawned.length, 1)
})

test("hard limit stops protection and immediate idle/busy resets it", async (t) => {
  const h = await setup(t)
  await h.send(status("a"))
  await flush()
  await h.tick(600_000)
  assert.equal(h.alive().length, 0)
  assert.equal(h.logs.length, 1)
  await h.send(status("a"))
  await flush()
  assert.equal(h.alive().length, 0)
  await h.send(status("a", "idle"))
  await h.send(status("a"))
  await flush()
  assert.equal(h.alive().length, 1)
})

test("dispose cancels queued starts and ignores subsequent events", async (t) => {
  const h = await setup(t)
  await h.send(status("a"))
  await h.dispose()
  await flush()
  assert.equal(spawned.length, 0)
  await h.send(status("a"))
  await h.tick(600_000)
  assert.equal(spawned.length, 0)
})

test("spawn failure does not fail the event handler", async (t) => {
  const h = await setup(t)
  failSpawn = true
  await h.send(status("a"))
  await flush()
  assert.equal(h.logs.length, 1)
  failSpawn = false
  await h.tick(60_000)
  await h.tick(60_000)
  assert.equal(spawned.length, 2)
})

test("invalid limits are rejected before starting processes", async (t) => {
  const h = await setup(t)
  for (const maxSeconds of ["600", -1, 299, 300.1, NaN, Infinity, 2_147_484]) {
    await assert.rejects(plugin({ client: h.client }, { maxSeconds }), /maxSeconds/)
  }
  assert.equal(spawned.length, 0)
})

test("an old snapshot after a busy event cannot cancel new work", async (t) => {
  const h = await setup(t)
  await h.send(status("a"))
  await flush()
  h.deferStatus(async () => ({ data: {} }))
  await h.tick(60_000)
  assert.equal(h.alive().length, 1)
  h.deferStatus(async () => ({ data: { a: { type: "busy" } } }))
  await h.tick(60_000)
  await h.tick(60_000)
  assert.equal(h.alive().length, 1)
  assert.equal(spawned.length, 2)
})

test("transport ignoring abort cannot block polling or apply its late result", async (t) => {
  const h = await setup(t)
  await h.send(status("a"))
  await flush()
  const late = Promise.withResolvers<{ data: Record<string, SessionStatus> }>()
  h.deferStatus(() => late.promise)
  await h.tick(60_000)
  await h.tick(5_000)
  h.deferStatus(async () => ({ data: { a: { type: "busy" } } }))
  await h.tick(55_000)
  await h.tick(60_000)
  assert.equal(spawned.length, 2)
  late.resolve({ data: {} })
  await flush()
  assert.equal(h.alive().length, 1)
})
