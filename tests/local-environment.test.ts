import assert from "node:assert/strict"
import test from "node:test"
import { localEnvironments, validateLocalSettings } from "../scripts/local-settings"
import { assertIntegrationTarget } from "./integration-target"

test("development and integration have independent storage, credentials, apps and ports", () => {
  const dev = localEnvironments.development
  const integration = localEnvironments.integration
  for (const key of ["garage", "garagePort", "app", "appPort", "network", "envFile"] as const)
    assert.notEqual(dev[key], integration[key])
  const credentials = {
    S3_REGION: "garage",
    S3_ACCESS_KEY_ID: "fixture-key",
    S3_SECRET_ACCESS_KEY: "fixture-secret",
    SILO_ADMIN_USERNAME: "admin",
    SILO_ADMIN_PASSWORD_HASH: "fixture-hash",
    SILO_DEV_PASSWORD: "fixture-password",
    SILO_TEST_PASSWORD: "fixture-password"
  }
  const development = {
    ...credentials,
    SILO_ENVIRONMENT: "development",
    S3_ENDPOINT: "http://127.0.0.1:3909"
  }
  validateLocalSettings("development", development)
  assert.throws(() => assertIntegrationTarget(development), /development storage is forbidden/)
  assert.throws(() => assertIntegrationTarget({ ...development, SILO_ENVIRONMENT: "integration" }))
  const isolated = {
    ...credentials,
    SILO_ENVIRONMENT: "integration",
    S3_ENDPOINT: "http://127.0.0.1:3911",
    SILO_TEST_URL: "http://127.0.0.1:3302"
  }
  assertIntegrationTarget(isolated)
  assert.throws(() =>
    assertIntegrationTarget({ ...isolated, SILO_TEST_URL: "http://127.0.0.1:3301" })
  )
  assert.throws(() => assertIntegrationTarget({ ...isolated, SILO_TEST_PASSWORD: undefined }))
})
