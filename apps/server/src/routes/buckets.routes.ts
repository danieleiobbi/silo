import { Router } from "express"
import { bucketsController } from "../controllers/buckets.controller.js"
import type { S3Service } from "../services/s3.service.js"

export function bucketsRoutes(s3: S3Service) {
  const controller = bucketsController(s3)
  return Router().get("/", controller.list).delete("/:bucket", controller.remove)
}
