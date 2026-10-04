import { createApp } from "./app.js"
import { readEnv } from "./config/env.js"
import { createS3Service } from "./services/s3.service.js"

try {
  const config = readEnv()
  const app = createApp(createS3Service(config), {
    ...config.auth,
    maxUploadBytes: config.maxUploadBytes
  })
  app
    .listen(config.port, () => console.info(`Silo listening on port ${config.port}`))
    .on("error", error => {
      console.error("Silo could not start", error.name)
      process.exit(1)
    })
} catch (error) {
  console.error(error instanceof Error ? error.message : "Silo could not start")
  process.exit(1)
}
