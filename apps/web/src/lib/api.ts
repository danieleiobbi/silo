let sessionGeneration = 0

export function invalidateSessionRequests() {
  sessionGeneration++
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const generation = sessionGeneration
  const response = await fetch(`/api${path}`, options)
  if (!path.startsWith("/auth/") && generation !== sessionGeneration)
    throw new DOMException("Session changed", "AbortError")
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    if (!path.startsWith("/auth/") && generation !== sessionGeneration)
      throw new DOMException("Session changed", "AbortError")
    if (response.status === 401 && !path.startsWith("/auth/")) {
      invalidateSessionRequests()
      window.dispatchEvent(new Event("silo-session-expired"))
    }
    throw new Error(body?.error ?? "The request could not be completed")
  }
  const result = response.status === 204 ? undefined : await response.json()
  if (!path.startsWith("/auth/") && generation !== sessionGeneration)
    throw new DOMException("Session changed", "AbortError")
  return result as T
}
