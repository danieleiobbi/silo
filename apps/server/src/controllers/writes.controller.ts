import { Transform } from "node:stream"
import { finished } from "node:stream/promises"
import type { Request, Response } from "express"
import type { S3Service } from "../services/s3.service.js"
import {
  keyError,
  nameError,
  newObjectKey,
  MAX_ACTIVE_UPLOADS,
  UPLOAD_DEADLINE_MS
} from "../lib/write-validation.js"

let activeUploads = 0
class UploadCounter extends Transform {
  private received = 0
  constructor(private readonly expected: number) {
    super({ highWaterMark: 64 * 1024 })
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ) {
    this.received += chunk.length
    if (this.received > this.expected)
      callback(Object.assign(new Error("Upload length mismatch"), { name: "UploadLengthMismatch" }))
    else callback(null, chunk)
  }
  override _flush(callback: (error?: Error | null) => void) {
    callback(
      this.received === this.expected
        ? undefined
        : Object.assign(new Error("Upload length mismatch"), { name: "UploadLengthMismatch" })
    )
  }
}

export function writesController(s3: S3Service, maxUploadBytes: number) {
  return {
    async folder(request: Request<{ bucket: string }>, response: Response) {
      const body = request.body as unknown
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        !("prefix" in body) ||
        !("name" in body) ||
        typeof body.prefix !== "string" ||
        typeof body.name !== "string" ||
        Object.keys(body).length !== 2
      ) {
        response.status(400).json({ error: "Provide a prefix and one folder name" })
        return
      }
      const key = newObjectKey(body.prefix, body.name, true)
      const error = nameError(body.name, true) ?? keyError(key)
      if (error) {
        response.status(400).json({ error })
        return
      }
      response.status(201).json(await s3.createFolder(request.params.bucket, key))
    },
    async upload(request: Request<{ bucket: string }>, response: Response) {
      const { key, size: rawSize, overwrite = "false" } = request.query
      if (
        typeof key !== "string" ||
        typeof rawSize !== "string" ||
        !/^\d+$/.test(rawSize) ||
        (overwrite !== "false" && overwrite !== "true")
      ) {
        response
          .status(400)
          .json({ error: "Provide an exact key, integer size and valid overwrite flag" })
        return
      }
      const size = Number(rawSize)
      const error = keyError(key) ?? nameError(key.split("/").at(-1)!)
      if (error || !Number.isSafeInteger(size)) {
        response.status(400).json({ error: error ?? "Invalid upload size" })
        return
      }
      if (size > maxUploadBytes) {
        response.status(413).json({
          error: `Files must be at most ${maxUploadBytes / (1024 * 1024)} MiB`,
          code: "UploadTooLarge"
        })
        return
      }
      const length = request.get("content-length")
      if (length !== undefined && Number(length) !== size) {
        response
          .status(400)
          .json({ error: "The declared size does not match Content-Length", code: "SizeMismatch" })
        return
      }
      if (activeUploads >= MAX_ACTIVE_UPLOADS) {
        response.setHeader("Retry-After", "1")
        response
          .status(429)
          .json({ error: "Two uploads are already active. Retry later.", code: "UploadAdmission" })
        return
      }
      activeUploads++
      const abort = new AbortController()
      const counter = new UploadCounter(size)
      let failure: Error | undefined
      const stop = () => abort.abort()
      const closed = () => {
        if (!response.writableEnded) stop()
      }
      const deadline = setTimeout(() => {
        failure = Object.assign(new Error("Upload deadline exceeded"), { name: "UploadTimeout" })
        stop()
      }, UPLOAD_DEADLINE_MS)
      deadline.unref()
      const streamError = (error: Error) => {
        failure = error
        stop()
      }
      counter.on("error", streamError)
      request.on("aborted", stop)
      response.on("close", closed)
      try {
        // I check existence before consuming bytes and never authorize overwrite from a collision.
        await s3.checkUpload(request.params.bucket, key, overwrite === "true", abort.signal)
        if (abort.signal.aborted)
          throw failure ?? Object.assign(new Error("Upload disconnected"), { name: "AbortError" })
        request.pipe(counter)
        const counted = finished(counter, { readable: false, cleanup: true })
        await Promise.all([
          counted,
          s3.upload(request.params.bucket, key, size, counter, overwrite === "true", abort.signal)
        ])
        response.status(201).json({ key, size })
      } catch (error) {
        if (!response.destroyed) {
          response.setHeader("Connection", "close")
          throw failure ?? error
        }
      } finally {
        clearTimeout(deadline)
        request.off("aborted", stop)
        response.off("close", closed)
        request.unpipe(counter)
        abort.abort()
        counter.destroy()
        counter.off("error", streamError)
        activeUploads--
      }
    }
  }
}
