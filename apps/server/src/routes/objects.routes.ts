import { Router } from "express"
import { objectsController } from "../controllers/objects.controller.js"
import type { S3Service } from "../services/s3.service.js"

export function objectsRoutes(s3: S3Service) {
  const controller = objectsController(s3)
  return Router()
    .get("/:bucket/objects", controller.list)
    .delete("/:bucket/objects", controller.remove)
    .get("/:bucket/object", controller.details)
    .get("/:bucket/search", controller.search)
    .get("/:bucket/download", controller.download)
}
