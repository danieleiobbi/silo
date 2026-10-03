import { Router } from "express"
import { health } from "../controllers/health.controller.js"

export const healthRoutes = Router().get("/health", health)
