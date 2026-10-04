export const localEnvironments = {
  development: {
    garage: "silo-garage-dev",
    image: "dxflrs/garage:v2.1.0",
    garagePort: "3909",
    app: "silo-development",
    appImage: "silo:development",
    appPort: "3301",
    network: "silo-development",
    envFile: ".env.development",
    overlay: "compose.dev.yaml",
    passwordVariable: "SILO_DEV_PASSWORD"
  },
  integration: {
    garage: "silo-garage-integration",
    image: "dxflrs/garage:v2.1.0",
    garagePort: "3911",
    app: "silo-integration",
    appImage: "silo:integration",
    appPort: "3302",
    network: "silo-integration",
    envFile: ".env.silo-test",
    overlay: "compose.test.yaml",
    passwordVariable: "SILO_TEST_PASSWORD"
  },
  "write-compatibility": {
    garage: "silo-garage-write-test",
    image: "dxflrs/garage:v2.4.1",
    garagePort: "3910",
    app: "",
    appImage: "",
    appPort: "3302",
    network: "",
    envFile: ".env.silo-write-test",
    overlay: "",
    passwordVariable: "SILO_TEST_PASSWORD"
  }
} as const
export type LocalEnvironment = keyof typeof localEnvironments

export function validateLocalSettings(
  profile: LocalEnvironment,
  env: Record<string, string | undefined>
) {
  const settings = localEnvironments[profile]
  if (
    env.SILO_ENVIRONMENT !== profile ||
    env.S3_ENDPOINT !== `http://127.0.0.1:${settings.garagePort}` ||
    env.S3_REGION !== "garage" ||
    !env.S3_ACCESS_KEY_ID ||
    !env.S3_SECRET_ACCESS_KEY ||
    !env.SILO_ADMIN_USERNAME ||
    !env.SILO_ADMIN_PASSWORD_HASH ||
    !env[settings.passwordVariable]
  )
    throw new Error(`Settings do not describe the isolated ${profile} environment`)
}
