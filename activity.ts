import type { Event as LegacyEvent } from "@opencode-ai/sdk"
import type { Event, SessionStatus } from "@opencode-ai/sdk/v2"

export type ActivityEvent = LegacyEvent | Event

type Session = {
  busy: boolean
  tools: Map<string, string | undefined>
  waits: Map<string, string | undefined>
}

export function createActivity() {
  const sessions = new Map<string, Session>()
  const toolKey = (messageID: string, callID: string) => JSON.stringify([messageID, callID])

  function session(id: string): Session {
    let value = sessions.get(id)
    if (!value) {
      value = { busy: false, tools: new Map(), waits: new Map() }
      sessions.set(id, value)
    }
    return value
  }

  function working(id: string, visiting = new Set<string>()): boolean {
    const state = sessions.get(id)
    if (!state?.busy) return false
    // Missing child state or a cycle is not proof that work has stopped.
    if (visiting.has(id)) return true
    const path = new Set(visiting).add(id)
    for (const [key, childID] of state.tools) {
      if ([...state.waits.values()].includes(key)) continue
      if (childID && sessions.get(childID)?.busy && !working(childID, path)) continue
      return true
    }
    return state.tools.size === 0 && state.waits.size === 0
  }

  return {
    hasSessions: () => sessions.size > 0,
    isWorking: () => [...sessions.keys()].some((id) => working(id)),
    clear: () => sessions.clear(),
    reconcile(statuses: Record<string, SessionStatus>) {
      for (const id of sessions.keys()) {
        const status = statuses[id]?.type
        if (status !== "busy" && status !== "retry") sessions.delete(id)
      }
      for (const [id, status] of Object.entries(statuses)) {
        if (status.type === "busy" || status.type === "retry") session(id).busy = true
      }
    },
    update(event: ActivityEvent): boolean {
      switch (event.type) {
        case "session.status": {
          const { sessionID, status } = event.properties
          if (status.type === "idle") sessions.delete(sessionID)
          else session(sessionID).busy = true
          break
        }
        case "session.deleted":
          sessions.delete(event.properties.info.id)
          break
        case "message.part.updated": {
          const { part } = event.properties
          if (part.type !== "tool") return false
          const key = toolKey(part.messageID, part.callID)
          if (part.state.status === "pending" || part.state.status === "running") {
            const state = session(part.sessionID)
            const childID = part.state.status === "running" && part.tool === "task"
              ? part.state.metadata?.sessionId : undefined
            state.tools.set(key, typeof childID === "string" ? childID : undefined)
          } else {
            const state = sessions.get(part.sessionID)
            if (!state) return false
            state.tools.delete(key)
            for (const [request, blockedTool] of state.waits) {
              if (blockedTool === key) state.waits.delete(request)
            }
            if (!state.busy && !state.tools.size && !state.waits.size) sessions.delete(part.sessionID)
          }
          break
        }
        case "permission.asked":
        case "question.asked": {
          const { sessionID, id, tool } = event.properties
          session(sessionID).waits.set(
            `${event.type.split(".")[0]}:${id}`,
            tool ? toolKey(tool.messageID, tool.callID) : undefined,
          )
          break
        }
        case "permission.replied":
        case "question.replied":
        case "question.rejected": {
          if (!("requestID" in event.properties)) return false
          const { sessionID, requestID } = event.properties
          const state = sessions.get(sessionID)
          state?.waits.delete(`${event.type.split(".")[0]}:${requestID}`)
          if (state && !state.busy && !state.tools.size && !state.waits.size) sessions.delete(sessionID)
          break
        }
        default:
          return false
      }
      return true
    },
  }
}
