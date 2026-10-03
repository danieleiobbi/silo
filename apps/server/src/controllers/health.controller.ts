import type { Request, Response } from "express"

export function health(_request: Request, response: Response) {
  // I check HTTP liveness only. I do not contact S3: a storage outage should not
  // cause a healthy application container to be restarted.
  response.json({ status: "ok" })
}
