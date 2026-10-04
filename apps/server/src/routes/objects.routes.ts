import { Router } from "express"
import { objectsController } from "../controllers/objects.controller.js"
import type { S3Service } from "../services/s3.service.js"
import { writesController } from "../controllers/writes.controller.js"

export function objectsRoutes(s3: S3Service, maxUploadBytes: number) {
  const controller = objectsController(s3)
  const writes = writesController(s3, maxUploadBytes)
  return Router()
    .get("/:bucket/objects", controller.list)
    .post("/:bucket/folders", writes.folder)
    .put("/:bucket/object", writes.upload)
    .delete("/:bucket/objects", controller.remove)
    .get("/:bucket/object", controller.details)
    .get("/:bucket/search", controller.search)
    .get("/:bucket/download", controller.download)
}
