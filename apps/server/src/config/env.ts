export function readEnv(env = process.env) {
  for (const name of [
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "PORT"
  ]) {
    if (!env[name]?.trim()) throw new Error(`${name} is required`)
  }
  let endpoint: URL
  try {
    endpoint = new URL(env.S3_ENDPOINT!)
  } catch {
    throw new Error("S3_ENDPOINT must be an HTTP(S) URL")
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("S3_ENDPOINT must be an HTTP(S) URL without credentials, query or fragment")
  }
  const port = Number(env.PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535")
  // I keep credentials in the server process and pass them explicitly to the SDK.
  // I do not fall back to local AWS profiles or expose this configuration to the browser.
  return {
    port,
    endpoint: endpoint.href,
    region: env.S3_REGION!,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! }
  }
}
