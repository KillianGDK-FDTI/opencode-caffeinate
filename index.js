import { spawn } from "node:child_process"

export default async function caffeinatePlugin({ client }, options = {}) {
  if (process.platform !== "darwin") return {}

  const maxSeconds = options.maxSeconds ?? 14_400
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 300 || maxSeconds > 2_147_483) {
    throw new Error("opencode-caffeinate: maxSeconds must be an integer between 300 and 2147483")
  }

  const active = new Set()
  const waiting = new Map()
  const children = new Set()
  let current
  let started = 0
  let renewed = 0
  let revision = 0
  let disposed = false
  let checking = false
  let exhausted = false
  let scheduled = false
  let deadline

  function log(message) {
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
    const working = [...active].some((id) => ![...waiting.values()].includes(id))
    if (!working) {
      stop()
      clearTimeout(deadline)
      started = 0
      exhausted = false
      return
    }
    if (exhausted) return
    if (!started) {
      started = Date.now()
      deadline = setTimeout(() => {
        exhausted = true
        stop()
        log("Continuous activity limit reached; sleep prevention suspended until idle.")
      }, maxSeconds * 1000)
      deadline.unref()
    }
    const remaining = Math.floor(maxSeconds - (Date.now() - started) / 1000)
    if (remaining <= 0) return
    if (current && Date.now() - renewed < 180_000) return

    // Native expiry and PID watching still work if JS freezes or OpenCode crashes.
    const previous = current
    const child = spawn("/usr/bin/caffeinate", [
      "-i", "-t", String(Math.min(300, remaining)), "-w", String(process.pid),
    ], { stdio: "ignore" })
    children.add(child)
    current = child
    renewed = Date.now()
    child.unref()
    child.once("spawn", () => {
      if (disposed || current !== child) child.kill()
      // Release the old assertion only after its replacement has started.
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
    if (![...active].some((id) => ![...waiting.values()].includes(id))) {
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

  // A failed health check never renews the lease. Discard snapshots raced by events.
  const timer = setInterval(async () => {
    if (checking || disposed || !active.size) return
    checking = true
    const version = revision
    try {
      const result = await client.session.status({ signal: AbortSignal.timeout(5_000) })
      if (disposed || version !== revision || result.error || !result.data) return
      active.clear()
      for (const [id, status] of Object.entries(result.data)) {
        if (status.type === "busy" || status.type === "retry") active.add(id)
      }
      for (const [request, id] of waiting) {
        if (!active.has(id)) waiting.delete(request)
      }
      reconcile()
    } catch {
      // Let the native lease expire if the server stops responding.
    } finally {
      checking = false
    }
  }, 60_000)
  timer.unref()

  return {
    event: async ({ event }) => {
      if (disposed) return
      const p = event.properties
      if (event.type === "session.status") {
        if (p.status.type === "busy" || p.status.type === "retry") active.add(p.sessionID)
        else {
          active.delete(p.sessionID)
          for (const [request, id] of waiting) {
            if (id === p.sessionID) waiting.delete(request)
          }
        }
      } else if (event.type === "session.deleted") {
        active.delete(p.info.id)
        for (const [request, id] of waiting) {
          if (id === p.info.id) waiting.delete(request)
        }
      } else if (event.type === "permission.asked" || event.type === "question.asked") {
        waiting.set(`${event.type.split(".")[0]}:${p.id}`, p.sessionID)
      } else if (["permission.replied", "question.replied", "question.rejected"].includes(event.type)) {
        waiting.delete(`${event.type.split(".")[0]}:${p.requestID}`)
      } else return
      revision++
      schedule()
    },
    dispose: async () => {
      disposed = true
      clearInterval(timer)
      clearTimeout(deadline)
      stop()
      active.clear()
      waiting.clear()
    },
  }
}
