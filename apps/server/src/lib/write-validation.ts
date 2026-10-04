// I validate only newly created names; I leave existing bucket navigation unrestricted.
export function bucketNameError(name: unknown): string | undefined {
  if (
    typeof name !== "string" ||
    name.length < 3 ||
    name.length > 63 ||
    /[^a-z0-9-]/.test(name) ||
    name.startsWith("-") ||
    name.endsWith("-")
  )
    return "Use 3–63 lowercase letters, digits or hyphens, starting and ending with a letter or digit"
  // I reject AWS-reserved names applicable to this subset, including account-regional names.
  // I never rewrite, lowercase or trim the submitted name.
  if (
    ["xn--", "sthree-", "amzn-s3-demo-"].some(prefix => name.startsWith(prefix)) ||
    ["-s3alias", "--ol-s3", "--x-s3", "--table-s3", "-an"].some(suffix => name.endsWith(suffix))
  )
    return "This bucket name uses a reserved prefix or suffix"
  return undefined
}
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
export const MAX_QUEUE_ENTRIES = 100
export const MAX_ACTIVE_UPLOADS = 2
export const UPLOAD_DEADLINE_MS = 5 * 60 * 1000

export function destinationBase(prefix: string) {
  return !prefix || prefix.endsWith("/") ? prefix : `${prefix}/`
}

export function keyError(key: string): string | undefined {
  if (
    [...key].some(
      character =>
        character.length === 1 &&
        character.charCodeAt(0) >= 0xd800 &&
        character.charCodeAt(0) <= 0xdfff
    )
  )
    return "Use well-formed Unicode for the destination"
  if (!key || new TextEncoder().encode(key).length > 1024)
    return "The complete destination key must be between 1 and 1,024 UTF-8 bytes"
}

export function newObjectKey(prefix: string, name: string, folder = false): string {
  return `${destinationBase(prefix)}${name}${folder ? "/" : ""}`
}

export function nameError(name: string, folder = false): string | undefined {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..")
    return "Enter one name without slashes; dot and dot-dot names are not allowed"
  if (
    folder &&
    (!name.trim() ||
      [...name].some(character => {
        const code = character.codePointAt(0)!
        return code < 32 || (code >= 127 && code <= 159)
      }))
  )
    return "Folder names cannot be blank or contain control characters"
}
