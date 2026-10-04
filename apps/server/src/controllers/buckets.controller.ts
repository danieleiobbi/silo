import type { Request, Response } from "express"
import type { S3Service } from "../services/s3.service.js"
import { bucketNameError } from "../lib/write-validation.js"

export function bucketsController(s3: S3Service) {
  return {
    async create(request: Request, response: Response) {
      const body: unknown = request.body
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !("name" in body)
      ) {
        response
          .status(400)
          .json({ error: "Provide only a bucket name", code: "InvalidBucketName" })
        return
      }
      const error = bucketNameError(body.name)
      if (error) {
        response.status(400).json({ error, code: "InvalidBucketName" })
        return
      }
      response.status(201).json(await s3.createBucket(body.name as string))
    },
    async remove(request: Request<{ bucket: string }>, response: Response) {
      if (request.body?.confirmation !== request.params.bucket) {
        response.status(400).json({ error: "Type the exact bucket name to confirm deletion" })
        return
      }
      await s3.deleteBucket(request.params.bucket)
      response.json({ deleted: true })
    },
    async list(_request: Request, response: Response) {
      response.json(await s3.listBuckets())
    }
  }
}
