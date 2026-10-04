import { Router, type Request, type RequestHandler } from "express"
import type { readEnv } from "../config/env.js"
import { validPassword, verifyPassword } from "./password.js"
import { createSessions } from "./sessions.js"

const LOGIN_WINDOW = 5 * 60 * 1000
const MAX_ATTEMPTS = 10

export function createAuth(config: ReturnType<typeof readEnv>["auth"], now = Date.now) {
  const sessions = createSessions(now)
  const secure = config.publicOrigin.startsWith("https:")
  const cookieName = secure ? "__Host-silo_session" : "silo_session"
  const cookieOptions = { secure, httpOnly: true, sameSite: "lax" as const, path: "/" }
  const token = (request: Request) => {
    const cookies = (request.get("cookie") ?? "").split(";").map(value => value.trim())
    const matches = cookies.filter(value => value.startsWith(`${cookieName}=`))
    return matches.length === 1 ? matches[0].slice(cookieName.length + 1) : undefined
  }
  const requireOrigin: RequestHandler = (request, response, next) => {
    let origin: URL | undefined
    try {
      origin = new URL(request.get("origin") ?? "")
    } catch {
      // I reject absent and malformed origins without reflecting the supplied value.
    }
    if (
      request.get("sec-fetch-site") === "cross-site" ||
      !origin ||
      origin.origin !== config.publicOrigin ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      response.status(403).json({ error: "A same-origin request is required" })
      return
    }
    next()
  }
  const mutation: RequestHandler = (request, response, next) => {
    if (!request.is("application/json")) {
      response.status(403).json({ error: "A same-origin JSON request is required" })
      return
    }
    requireOrigin(request, response, next)
  }
  const requireSession: RequestHandler = (request, response, next) => {
    if (!sessions.authenticate(token(request))) {
      response.status(401).json({ error: "Authentication required" })
      return
    }
    next()
  }
  let attempts: number[] = []
  let verifying = false
  const routes = Router()
  routes.get("/session", requireSession, (_request, response) =>
    response.json({ username: config.username })
  )
  routes.post("/logout", (request, response) => {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      response.status(400).json({ error: "Invalid request body" })
      return
    }
    sessions.remove(token(request))
    response.clearCookie(cookieName, cookieOptions).status(204).end()
  })
  routes.post("/login", async (request, response) => {
    const { username, password } = request.body ?? {}
    if (
      typeof username !== "string" ||
      !username ||
      Array.from(username).length > 128 ||
      typeof password !== "string" ||
      !validPassword(password)
    ) {
      response.status(400).json({ error: "Invalid login input" })
      return
    }
    const time = now()
    attempts = attempts.filter(attempt => time - attempt < LOGIN_WINDOW)
    if (verifying || attempts.length >= MAX_ATTEMPTS) {
      const retry =
        attempts.length >= MAX_ATTEMPTS ? Math.ceil((attempts[0] + LOGIN_WINDOW - time) / 1000) : 1
      response.setHeader("Retry-After", String(retry))
      response.status(429).json({ error: "Too many login attempts. Try again later." })
      return
    }
    attempts.push(time)
    verifying = true
    try {
      // I verify the password even for an unknown username within the same admission budget.
      const valid = await verifyPassword(password, config.passwordHash)
      if (!valid || username !== config.username) {
        response.status(401).json({ error: "Invalid username or password" })
        return
      }
      response.cookie(cookieName, sessions.create(token(request)), cookieOptions)
      response.json({ username: config.username })
    } finally {
      verifying = false
    }
  })
  return { routes, requireSession, requireOrigin, mutation }
}
