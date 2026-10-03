import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { Request, Response } from "express"
import type { S3Service } from "../services/s3.service.js"

export function objectsController(s3: S3Service) {
  return {
    async remove(request: Request<{ bucket: string }>, response: Response) {
      const keys: unknown = request.body?.keys
      // I require explicit, distinct keys and cap deletion at one 100-object page.
      // I never normalize keys: dots, repeated slashes and whitespace can identify different objects.
      if (
        !Array.isArray(keys) ||
        keys.length < 1 ||
        keys.length > 100 ||
        keys.some(
          key => typeof key !== "string" || !key || Buffer.byteLength(key, "utf8") > 1024
        ) ||
        new Set(keys).size !== keys.length
      ) {
        response.status(400).json({ error: "Select between 1 and 100 distinct object keys" })
        return
      }
      const result = await s3.deleteObjects(request.params.bucket, keys)
      if (result.errors.length)
        console.error("S3 batch deletion partially failed", result.errors.length)
      response.json(result)
    },
    async search(request: Request<{ bucket: string }>, response: Response) {
      const { prefix = "", query } = request.query
      if (typeof prefix !== "string" || typeof query !== "string" || [...query].length < 3) {
        response.status(400).json({ error: "Enter at least 3 characters" })
        return
      }
      response.json(await s3.search(request.params.bucket, prefix, query))
    },
    async details(request: Request<{ bucket: string }>, response: Response) {
      const key = request.query.key
      if (typeof key !== "string" || !key) {
        response.status(400).json({ error: "An object key is required" })
        return
      }
      response.json(await s3.details(request.params.bucket, key))
    },
    async download(request: Request<{ bucket: string }>, response: Response) {
      const key = request.query.key
      if (typeof key !== "string" || !key) {
        response.status(400).json({ error: "An object key is required" })
        return
      }
      const abort = new AbortController()
      const cancel = () => abort.abort()
      response.on("close", cancel)
      try {
        const object = await s3.download(request.params.bucket, key, abort.signal)
        if (!(object.Body instanceof Readable)) throw new Error("Missing S3 response stream")
        // I use the final slash-separated S3 key segment as the filename, without
        // interpreting backslashes as folders. I encode UTF-8 names for the header
        // and do not reflect arbitrary Content-Disposition metadata from storage.
        const name = key.split("/").at(-1) || "download"
        const encoded = encodeURIComponent(name).replace(
          /[!'()*]/g,
          character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
        )
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="download"; filename*=UTF-8''${encoded}`
        )
        response.setHeader("Content-Type", "application/octet-stream")
        response.setHeader("X-Content-Type-Options", "nosniff")
        if (object.ContentLength !== undefined)
          response.setHeader("Content-Length", object.ContentLength)
        // I pipe the S3 body directly to HTTP to preserve backpressure and bounded memory.
        // I abort the upstream request when the browser disconnects, including before headers arrive.
        await pipeline(object.Body, response, { signal: abort.signal })
      } finally {
        response.off("close", cancel)
      }
    },
    async list(request: Request<{ bucket: string }>, response: Response) {
      const { prefix = "", token, limit = "50" } = request.query
      if (
        typeof prefix !== "string" ||
        (token !== undefined && typeof token !== "string") ||
        typeof limit !== "string" ||
        !["25", "50", "100"].includes(limit)
      ) {
        response.status(400).json({ error: "Invalid prefix, continuation token or page size" })
        return
      }
      response.json(await s3.listObjects(request.params.bucket, prefix, Number(limit), token))
    }
  }
}
