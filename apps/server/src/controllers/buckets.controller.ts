import type { Request, Response } from "express"
import type { S3Service } from "../services/s3.service.js"

export function bucketsController(s3: S3Service) {
  return {
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
