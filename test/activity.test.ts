import assert from "node:assert/strict"
import { test } from "node:test"
import { createActivity } from "../activity.ts"
import { ask, event, reply, status, tool } from "./events.ts"

test("tracks independent busy and retrying sessions", () => {
  const activity = createActivity()
  activity.update(status("a"))
  activity.update(status("b", "retry"))
  activity.update(status("a", "idle"))
  assert.equal(activity.isWorking(), true)
  activity.update(status("b", "idle"))
  assert.equal(activity.isWorking(), false)
})

for (const kind of ["question", "permission"]) {
  test(`${kind} only blocks its own tool, not parallel work`, () => {
    const activity = createActivity()
    activity.update(status("a"))
    activity.update(tool("a", "blocked"))
    activity.update(tool("a", "working"))
    activity.update(ask("a", "request", "blocked", kind))
    assert.equal(activity.isWorking(), true)
    activity.update(tool("a", "working", "completed"))
    assert.equal(activity.isWorking(), false)
    activity.update(reply("a", "request", kind))
    assert.equal(activity.isWorking(), true)
  })
}

test("correlates an asked event arriving before the tool part", () => {
  const activity = createActivity()
  activity.update(status("a"))
  activity.update(ask("a", "request", "blocked"))
  activity.update(tool("a", "blocked"))
  assert.equal(activity.isWorking(), false)
  activity.update(tool("a", "other", "pending"))
  assert.equal(activity.isWorking(), true)
})

test("unknown tool correlation conservatively preserves running work", () => {
  const activity = createActivity()
  activity.update(status("a"))
  activity.update(ask("a", "request"))
  assert.equal(activity.isWorking(), false)
  activity.update(tool("a", "unknown"))
  assert.equal(activity.isWorking(), true)
})

test("overlapping question and permission IDs are independent", () => {
  const activity = createActivity()
  activity.update(status("a"))
  activity.update(tool("a", "blocked"))
  activity.update(ask("a", "same", "blocked"))
  activity.update(ask("a", "same", "blocked", "permission"))
  activity.update(reply("a", "same"))
  assert.equal(activity.isWorking(), false)
  activity.update(reply("a", "same", "permission"))
  assert.equal(activity.isWorking(), true)
})

test("error cleans a tool wait even without a reply or after hook", () => {
  const activity = createActivity()
  activity.update(status("a"))
  activity.update(tool("a", "blocked"))
  activity.update(ask("a", "request", "blocked"))
  activity.update(tool("a", "blocked", "error"))
  assert.equal(activity.isWorking(), true)
  activity.update(status("a", "idle"))
  assert.equal(activity.isWorking(), false)
})

test("parent pauses with blocked child but preserves sibling work", () => {
  const activity = createActivity()
  activity.update(status("parent"))
  activity.update(tool("parent", "task", "running", "child"))
  activity.update(status("child"))
  activity.update(tool("child", "question"))
  activity.update(ask("child", "request", "question"))
  assert.equal(activity.isWorking(), false)
  activity.update(tool("parent", "sibling"))
  assert.equal(activity.isWorking(), true)
  activity.update(tool("parent", "sibling", "completed"))
  assert.equal(activity.isWorking(), false)
  activity.update(reply("child", "request"))
  assert.equal(activity.isWorking(), true)
})

test("background child remains protected after its parent completes", () => {
  const activity = createActivity()
  activity.update(status("parent"))
  activity.update(status("child"))
  activity.update(tool("parent", "task", "completed", "child"))
  activity.update(status("parent", "idle"))
  assert.equal(activity.isWorking(), true)
})

test("missing child status and cycles cannot falsely prove idle", () => {
  const activity = createActivity()
  activity.update(status("a"))
  activity.update(tool("a", "task", "running", "b"))
  assert.equal(activity.isWorking(), true)
  activity.update(status("b"))
  activity.update(tool("b", "task", "running", "a"))
  assert.equal(activity.isWorking(), true)
})

test("idle, deletion and polling remove tool and wait state", () => {
  const activity = createActivity()
  for (const id of ["a", "b", "c"]) {
    activity.update(status(id))
    activity.update(tool(id, "blocked"))
    activity.update(ask(id, "request", "blocked"))
  }
  activity.update(status("a", "idle"))
  activity.update(event("session.deleted", { info: { id: "b" } }))
  activity.reconcile({})
  assert.equal(activity.hasSessions(), false)
  activity.update(status("c"))
  assert.equal(activity.isWorking(), true)
  activity.clear()
  assert.equal(activity.isWorking(), false)
})

test("tool IDs are scoped by message and session", () => {
  const activity = createActivity()
  activity.update(status("a"))
  activity.update(tool("a", "same"))
  activity.update(ask("a", "request", "same"))
  activity.update(event("message.part.updated", { part: {
    type: "tool", sessionID: "a", messageID: "another", callID: "same",
    state: { status: "running" },
  } }))
  assert.equal(activity.isWorking(), true)
})

test("late tool and reply events do not retain empty inactive sessions", () => {
  const activity = createActivity()
  activity.update(status("a", "idle"))
  activity.update(tool("a", "late"))
  activity.update(tool("a", "late", "completed"))
  assert.equal(activity.hasSessions(), false)
  activity.update(ask("a", "late"))
  activity.update(reply("a", "late"))
  assert.equal(activity.hasSessions(), false)
  activity.update(tool("a", "abandoned"))
  activity.reconcile({})
  assert.equal(activity.hasSessions(), false)
})
