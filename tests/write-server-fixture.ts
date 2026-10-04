import { createApp } from "../apps/server/src/app.ts"
import { readEnv } from "../apps/server/src/config/env.ts"
import { createS3Service } from "../apps/server/src/services/s3.service.ts"
import { testAuth } from "./auth-helper.ts"

// I isolate server RSS from the upload producer and streamed readback in the parent test.
const server = createApp(createS3Service(readEnv()), testAuth).listen(0, "127.0.0.1")
server.once("listening", () => {
  process.send?.({ port: (server.address() as { port: number }).port })
})
let baseline = 0
let peak = 0
let sample: NodeJS.Timeout | undefined
process.on("message", message => {
  if (message === "measure") {
    baseline = peak = process.memoryUsage().rss
    sample = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss)
    }, 5)
    process.send?.({ baseline })
  } else if (message === "report") {
    clearInterval(sample)
    peak = Math.max(peak, process.memoryUsage().rss)
    process.send?.({ baseline, peak })
  }
})
process.on("disconnect", () => {
  clearInterval(sample)
  server.closeAllConnections()
  server.close()
})
