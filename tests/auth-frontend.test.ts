import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { api, invalidateSessionRequests } from "../apps/web/src/lib/api.ts"

test("late data and expired-session responses cannot cross a session transition", async () => {
  const events = new EventTarget()
  let expirations = 0
  events.addEventListener("silo-session-expired", () => expirations++)
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: events })
  let deliver!: (response: Response) => void
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise<Response>(resolve => {
        deliver = resolve
      })
  )
  try {
    for (const status of [200, 401]) {
      const pending = api("/buckets")
      invalidateSessionRequests()
      deliver(
        new Response(JSON.stringify(status === 200 ? [] : { error: "Authentication required" }), {
          status
        })
      )
      await assert.rejects(pending, { name: "AbortError" })
    }
    assert.equal(expirations, 0)
    const expired = api("/buckets")
    deliver(new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 }))
    await assert.rejects(expired, { message: "Authentication required" })
    assert.equal(expirations, 1)
    const denied = api("/buckets")
    deliver(
      new Response(JSON.stringify({ error: "Access denied by object storage" }), { status: 403 })
    )
    await assert.rejects(denied, { message: "Access denied by object storage" })
    assert.equal(expirations, 1)
  } finally {
    fetchMock.mock.restore()
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
