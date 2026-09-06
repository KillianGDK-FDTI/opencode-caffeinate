import type { ActivityEvent } from "../activity.ts"

// Fixtures carry the event fields consumed by the plugin, not unrelated SDK data.
export const event = (type: string, properties: object) => ({ type, properties }) as ActivityEvent
export const status = (id: string, type = "busy") => event("session.status", {
  sessionID: id, status: { type },
})
export const tool = (id: string, callID: string, state = "running", childID?: string) =>
  event("message.part.updated", {
    part: {
      type: "tool", id: `part-${callID}`, sessionID: id, messageID: "message", callID,
      tool: childID ? "task" : "bash",
      state: { status: state, metadata: childID ? { sessionId: childID } : {} },
    },
  })
export const ask = (id: string, requestID: string, callID?: string, kind = "question") =>
  event(`${kind}.asked`, {
    sessionID: id, id: requestID,
    ...(callID ? { tool: { messageID: "message", callID } } : {}),
  })
export const reply = (id: string, requestID: string, kind = "question", action = "replied") =>
  event(`${kind}.${action}`, { sessionID: id, requestID })
