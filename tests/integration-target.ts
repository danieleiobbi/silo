import { localEnvironments, validateLocalSettings } from "../scripts/local-settings"

export function assertIntegrationTarget(env = process.env) {
  const profile = env.SILO_ENVIRONMENT
  if (profile !== "integration" && profile !== "write-compatibility")
    throw new Error(
      "Integration tests require isolated test settings; development storage is forbidden"
    )
  validateLocalSettings(profile, env)
  if (
    env.SILO_TEST_URL &&
    env.SILO_TEST_URL !== `http://127.0.0.1:${localEnvironments[profile].appPort}`
  )
    throw new Error("The test app URL does not match the isolated integration environment")
}
