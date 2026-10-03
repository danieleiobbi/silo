import { hashPassword } from "./password.js"

async function prompt(label: string): Promise<string> {
  process.stderr.write(label)
  const input = process.stdin
  const wasRaw = input.isRaw
  input.setRawMode(true)
  input.resume()
  return new Promise((resolve, reject) => {
    let value = ""
    const cancel = () => finish(new Error("Password entry cancelled"))
    const finish = (error?: Error) => {
      input.off("data", onData)
      process.off("SIGINT", cancel)
      process.off("SIGTERM", cancel)
      process.off("SIGHUP", cancel)
      input.setRawMode(wasRaw)
      input.pause()
      process.stderr.write("\n")
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (data: string) => {
      for (const character of data) {
        if (character === "\u0003" || character === "\u0004") {
          finish(new Error("Password entry cancelled"))
          return
        }
        if (character === "\r" || character === "\n") {
          finish()
          return
        }
        if (character === "\u007f" || character === "\b")
          value = Array.from(value).slice(0, -1).join("")
        else value += character
      }
    }
    input.on("data", onData)
    process.once("SIGINT", cancel)
    process.once("SIGTERM", cancel)
    process.once("SIGHUP", cancel)
  })
}

try {
  if (process.argv.length !== 2 || !process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error("Use an interactive terminal without command-line arguments")
  process.stdin.setEncoding("utf8")
  const password = await prompt("Password: ")
  const confirmation = await prompt("Repeat password: ")
  if (password !== confirmation) throw new Error("Passwords do not match")
  process.stdout.write(`${await hashPassword(password)}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Password hashing failed"}\n`)
  process.exitCode = 1
}
