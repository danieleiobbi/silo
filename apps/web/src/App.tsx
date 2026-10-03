import { Theme } from "./components/Theme"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { ObjectsRoute } from "./pages/Objects"
import { Buckets } from "./pages/Buckets"
import { useEffect, useState } from "react"
import { api, invalidateSessionRequests } from "./lib/api"

export function App() {
  const [session, setSession] = useState<{ username: string } | null>(null)
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState("")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [pending, setPending] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    const expired = () => {
      setSession(null)
      setError("")
    }
    window.addEventListener("silo-session-expired", expired)
    fetch("/api/auth/session")
      .then(async response => {
        if (!active) return
        if (response.status === 401) setSession(null)
        else if (response.ok) {
          const value = await response.json()
          if (active) setSession(value)
        } else throw new Error("Session check failed. Try again.")
      })
      .catch(() => {
        if (active) setError("Unable to check your session. Try again.")
      })
      .finally(() => {
        if (active) setChecking(false)
      })
    return () => {
      active = false
      window.removeEventListener("silo-session-expired", expired)
    }
  }, [retry])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError("")
    try {
      setSession(
        await api<{ username: string }>("/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password })
        })
      )
    } catch (error) {
      setError(
        error instanceof TypeError
          ? "Unable to connect. Try again."
          : error instanceof Error
            ? error.message
            : "Login failed"
      )
    } finally {
      setPassword("")
      setPending(false)
    }
  }

  async function logout() {
    setPending(true)
    setError("")
    try {
      await api<void>("/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      })
      invalidateSessionRequests()
      setSession(null)
    } catch {
      setError("Unable to log out. Try again.")
    } finally {
      setPending(false)
    }
  }
  return (
    <BrowserRouter>
      <header className='flex h-16 items-center justify-between border-b border-[var(--border)] px-4 font-semibold tracking-tight sm:px-8'>
        <a href='/buckets' className='text-lg'>
          Silo
          <span className='ml-3 text-xs font-normal tracking-normal text-[var(--muted)]'>
            Object storage
          </span>
        </a>
        <div className='flex items-center gap-4'>
          {session && (
            <button type='button' onClick={logout} disabled={pending}>
              Logout
            </button>
          )}
          <Theme />
        </div>
      </header>
      {session && error && (
        <p role='alert' className='px-8 py-3'>
          {error}
        </p>
      )}
      {checking ? (
        <main className='p-8'>Checking session…</main>
      ) : !session ? (
        <main className='mx-auto max-w-sm px-4 py-16'>
          <h1 className='mb-6 text-2xl font-semibold'>Sign in to Silo</h1>
          <form onSubmit={submit} className='flex flex-col gap-4'>
            <label className='flex flex-col gap-2'>
              Username
              <input
                autoComplete='username'
                required
                value={username}
                onChange={event => setUsername(event.target.value)}
                disabled={pending}
              />
            </label>
            <label className='flex flex-col gap-2'>
              Password
              <input
                type='password'
                autoComplete='current-password'
                required
                value={password}
                onChange={event => setPassword(event.target.value)}
                disabled={pending}
              />
            </label>
            {error && <p role='alert'>{error}</p>}
            <button type='submit' disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </button>
            {error && (
              <button
                type='button'
                onClick={() => {
                  setChecking(true)
                  setError("")
                  setRetry(value => value + 1)
                }}
              >
                Retry session check
              </button>
            )}
          </form>
        </main>
      ) : (
        <Routes>
          <Route path='/' element={<Navigate to='/buckets' replace />} />
          <Route path='/buckets' element={<Buckets />} />
          <Route path='/buckets/:bucket' element={<ObjectsRoute />} />
          <Route
            path='*'
            element={
              <main className='p-8'>
                <h1>Page not found</h1>
                <a href='/buckets'>Go to buckets</a>
              </main>
            }
          />
        </Routes>
      )}
    </BrowserRouter>
  )
}
