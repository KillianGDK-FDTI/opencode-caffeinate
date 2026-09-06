import { spawn, type ChildProcess } from "node:child_process"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { createActivity, type ActivityEvent } from "./activity.ts"

export default (async function caffeinatePlugin(
  { client }: Pick<PluginInput, "client">,
  options: Record<string, unknown> = {},
) {
  if (process.platform !== "darwin") return {}

  const configuredLimit = options.maxSeconds ?? 14_400
  if (typeof configuredLimit !== "number" || !Number.isSafeInteger(configuredLimit)
    || configuredLimit < 300 || configuredLimit > 2_147_483) {
    throw new Error("opencode-caffeinate: maxSeconds must be an integer between 300 and 2147483")
  }
  const maxSeconds = configuredLimit

  const activity = createActivity()
  const children = new Set<ChildProcess>()
  let current: ChildProcess | undefined
  let started: number | undefined
  let renewed = 0
  let revision = 0
  let disposed = false
  let checking = false
  let exhausted = false
  let scheduled = false
  let snapshot: string | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined

  function log(message: string) {
    void client.app.log({
      body: { service: "opencode-caffeinate", level: "warn", message },
    }).catch(() => {})
  }

  function stop() {
    for (const child of children) child.kill()
    current = undefined
    renewed = 0
  }

  function reconcile() {
    if (disposed) return
    if (!activity.isWorking()) {
      stop()
      clearTimeout(deadline)
      started = undefined
      exhausted = false
      return
    }
    if (exhausted) return
    const now = performance.now()
    if (started === undefined) {
      started = now
      deadline = setTimeout(() => {
        exhausted = true
        stop()
        log("Continuous activity limit reached; sleep prevention suspended until idle.")
      }, maxSeconds * 1000)
      deadline.unref()
    }
    const remaining = Math.floor(maxSeconds - (now - started) / 1000)
    if (remaining <= 0) return
    if (current && now - renewed < 180_000) return

    // Native expiry and PID watching still work if JS freezes or OpenCode crashes.
    const previous = current
    const child = spawn("/usr/bin/caffeinate", [
      "-i", "-t", String(Math.min(300, remaining)), "-w", String(process.pid),
    ], { stdio: "ignore" })
    children.add(child)
    current = child
    renewed = now
    child.unref()
    child.once("spawn", () => {
      if (disposed || current !== child) child.kill()
      previous?.kill()
    })
    child.once("error", () => {
      children.delete(child)
      if (current === child) current = undefined
      log("Could not launch caffeinate; OpenCode will continue without sleep prevention.")
    })
    child.once("exit", () => {
      children.delete(child)
      if (current === child) current = undefined
    })
  }

  function schedule() {
    if (disposed) return
    // Do not coalesce away an idle transition followed immediately by new work.
    if (!activity.isWorking()) {
      reconcile()
      return
    }
    if (scheduled) return
    scheduled = true
    setImmediate(() => {
      scheduled = false
      reconcile()
    }).unref()
  }

  // OpenCode publishes status events before updating its status map. Confirm a
  // snapshot twice without intervening events before overriding event state.
  const timer = setInterval(async () => {
    if (checking || disposed || !activity.hasSessions()) return
    checking = true
    const version = revision
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        client.session.status({ signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort()
            reject(new Error("Status check timed out"))
          }, 5_000)
          timeout.unref()
        }),
      ])
      if (disposed || version !== revision || result.error || !result.data) return
      const key = JSON.stringify(Object.entries(result.data).map(([id, status]) => [id, status.type]).sort())
      if (snapshot !== key) {
        snapshot = key
        return
      }
      activity.reconcile(result.data)
      reconcile()
    } catch {
      // Let the native lease expire if the server stops responding.
    } finally {
      clearTimeout(timeout)
      checking = false
    }
  }, 60_000)
  timer.unref()

  return {
    event: async ({ event }: { event: ActivityEvent }) => {
      if (disposed || !activity.update(event)) return
      revision++
      snapshot = undefined
      schedule()
    },
    dispose: async () => {
      disposed = true
      clearInterval(timer)
      clearTimeout(deadline)
      stop()
      activity.clear()
    },
  }
}) satisfies Plugin
