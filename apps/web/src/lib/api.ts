let sessionGeneration = 0

export function invalidateSessionRequests() {
  sessionGeneration++
}
export function sessionVersion() {
  return sessionGeneration
}
export function expireSession() {
  invalidateSessionRequests()
  window.dispatchEvent(new Event("silo-session-expired"))
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const generation = sessionGeneration
  const isAuthRequest = path.startsWith("/auth/")
  const response = await fetch(`/api${path}`, options)
  if (!isAuthRequest && generation !== sessionGeneration)
    throw new DOMException("Session changed", "AbortError")
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    if (!isAuthRequest && generation !== sessionGeneration)
      throw new DOMException("Session changed", "AbortError")
    if (response.status === 401 && !isAuthRequest) {
      expireSession()
    }
    throw new Error(body?.error ?? "The request could not be completed")
  }
  const result = response.status === 204 ? undefined : await response.json()
  if (!isAuthRequest && generation !== sessionGeneration)
    throw new DOMException("Session changed", "AbortError")
  return result as T
}
