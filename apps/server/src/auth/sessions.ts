import { createHash, randomBytes } from "node:crypto"

export const IDLE_TIMEOUT = 30 * 60 * 1000
export const ABSOLUTE_LIFETIME = 8 * 60 * 60 * 1000
export const MAX_SESSIONS = 100

export function createSessions(now = Date.now) {
  const sessions = new Map<string, { created: number; active: number }>()
  const digest = (token: string) => createHash("sha256").update(token).digest("hex")
  const cleanup = () => {
    const time = now()
    for (const [key, session] of sessions) {
      if (time - session.active >= IDLE_TIMEOUT || time - session.created >= ABSOLUTE_LIFETIME)
        sessions.delete(key)
    }
  }
  const remove = (token?: string) => {
    cleanup()
    if (token) sessions.delete(digest(token))
  }
  return {
    remove,
    create(previous?: string) {
      remove(previous)
      if (sessions.size >= MAX_SESSIONS) {
        let oldest: string | undefined
        let activity = Infinity
        for (const [key, session] of sessions) {
          if (session.active < activity) {
            oldest = key
            activity = session.active
          }
        }
        if (oldest) sessions.delete(oldest)
      }
      const token = randomBytes(32).toString("base64url")
      const time = now()
      sessions.set(digest(token), { created: time, active: time })
      return token
    },
    authenticate(token?: string) {
      cleanup()
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false
      const session = sessions.get(digest(token))
      if (!session) return false
      session.active = now()
      return true
    }
  }
}
