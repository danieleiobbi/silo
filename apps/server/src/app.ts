import express, { type ErrorRequestHandler } from "express"
import { fileURLToPath } from "node:url"
import { healthRoutes } from "./routes/health.routes.js"

import { objectsRoutes } from "./routes/objects.routes.js"
import { bucketsRoutes } from "./routes/buckets.routes.js"
import type { S3Service } from "./services/s3.service.js"
import { createAuth } from "./auth/http.js"
import type { readEnv } from "./config/env.js"

export function createApp(
  s3: S3Service,
  config: ReturnType<typeof readEnv>["auth"],
  now = Date.now
) {
  const app = express()
  const auth = createAuth(config, now)
  app.disable("x-powered-by")
  app.use("/api", (request, response, next) => {
    response.setHeader("Cache-Control", "no-store")
    if (request.method === "DELETE") return auth.mutation(request, response, next)
    next()
  })
  app.use(
    "/api/auth",
    (request, response, next) => {
      if (request.method === "POST") return auth.mutation(request, response, next)
      next()
    },
    express.json({ limit: "4kb" })
  )
  app.use(express.json({ limit: "256kb" }))
  app.use("/api", healthRoutes)
  app.use("/api/auth", auth.routes)
  // I protect every subsequent API router before it can invoke object storage.
  app.use("/api", auth.requireSession)
  app.use("/api/buckets", bucketsRoutes(s3))
  app.use("/api/buckets", objectsRoutes(s3))
  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "Endpoint not found" })
  })

  // I resolve assets relative to this module so production startup does not depend
  // on the working directory. I keep the SPA fallback after all API routes.
  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url))
  app.use(express.static(webRoot))
  app.get("/{*path}", (_request, response) => {
    response.sendFile("index.html", { root: webRoot })
  })

  const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    // I log the error class rather than upstream messages, which may contain private
    // request details. I return fixed messages and never send stack traces to clients.
    console.error("HTTP request failed", error instanceof Error ? error.name : "UnknownError")
    if (response.headersSent || response.destroyed) {
      response.destroy()
      return
    }
    const name = error instanceof Error ? error.name : ""
    let status = 502
    let message = "Object storage is unavailable. Try again."
    switch (name) {
      case "AccessDenied":
      case "InvalidAccessKeyId":
      case "SignatureDoesNotMatch":
        status = 403
        message = "Access denied by object storage"
        break
      case "NoSuchBucket":
      case "NoSuchKey":
      case "NotFound":
        status = 404
        message = "Bucket or object no longer exists"
        break
      case "BucketNotEmpty":
        status = 409
        message = "Bucket is not empty. Silo never empties buckets automatically."
        break
      case "SyntaxError":
        status = 400
        message = "Invalid request body"
        break
      case "PayloadTooLargeError":
        status = 413
        message = "Request body is too large"
    }
    response.status(status).json({ error: message })
  }
  app.use(handleError)

  return app
}
