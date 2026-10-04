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
  app.use("/api/buckets", (request, response, next) => {
    if (request.method !== "POST" && request.method !== "PUT") return next()
    auth.requireOrigin(request, response, () => {
      if (request.method === "PUT") {
        if (!request.is("application/octet-stream") || request.get("content-encoding")) {
          response.status(415).json({
            error: "An unencoded application/octet-stream body is required",
            code: "UnsupportedBodyType"
          })
          return
        }
        return next()
      }
      if (!request.is("application/json")) {
        response
          .status(415)
          .json({ error: "A JSON request is required", code: "UnsupportedBodyType" })
        return
      }
      next()
    })
  })
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
      case "BucketNameConflict":
        response.status(409).json({
          error: "Bucket already exists. Refresh the bucket list and choose another name.",
          code: "BucketAlreadyExists"
        })
        return
      case "ObjectAlreadyExists":
        response.status(409).json({
          error: "This file already exists and will be overwritten. Confirm overwrite to continue.",
          code: "ObjectAlreadyExists"
        })
        return
      case "FolderAlreadyExists":
        response.status(409).json({ error: "Folder already exists", code: "FolderAlreadyExists" })
        return
      case "PreconditionFailed":
      case "ConditionalRequestConflict":
        response.status(409).json({
          error: "The destination changed. Inspect it before retrying.",
          code: "DestinationConflict"
        })
        return
      case "UploadLengthMismatch":
        response.status(400).json({
          error: "The received upload length differs from its declared size",
          code: "SizeMismatch"
        })
        return
      case "UploadTimeout":
        response.status(504).json({
          error:
            "Upload timed out; its outcome is unknown. Inspect the destination before retrying.",
          code: "OutcomeUnknown"
        })
        return
      case "StorageOperationNotSupported":
        response.status(501).json({
          error: "Object storage does not support bucket creation",
          code: "UnsupportedOperation"
        })
        return
      case "BucketCreationTimedOut":
      case "BucketCreationOutcomeUnknown":
        response.status(name === "BucketCreationTimedOut" ? 504 : 502).json({
          error:
            "Bucket creation outcome is unknown. Refresh the bucket list and inspect it before trying again.",
          code: "OutcomeUnknown"
        })
        return
      case "SyntaxError":
        status = 400
        message = "Invalid request body"
        break
      case "UnsupportedMediaTypeError":
        status = 415
        message = "Unsupported request body type or encoding"
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
