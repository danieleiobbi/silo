export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, options)
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error ?? "The request could not be completed")
  }
  return response.json() as Promise<T>
}
