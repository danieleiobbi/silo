import { Transfers } from "./components/Transfers"
import { Theme } from "./components/Theme"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { ObjectsRoute } from "./pages/Objects"
import { Buckets } from "./pages/Buckets"
import { useEffect, useState } from "react"
import { api, invalidateSessionRequests } from "./lib/api"
import { ArrowRight, LogOut } from "lucide-react"

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
      <header className='app-header'>
        <a href='/buckets' className='brand' aria-label='Silo home'>
          <span className='brand-name'>
            silo<span className='brand-dot'>.</span>
          </span>
          <span className='brand-description'>Storage explorer</span>
        </a>
        <div className='header-actions'>
          {session && <span className='session-name'>{session.username}</span>}
          {session && (
            <button className='button-quiet' type='button' onClick={logout} disabled={pending}>
              <LogOut size={16} aria-hidden />
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
        <main className='session-loading' role='status'>
          Checking session…
        </main>
      ) : !session ? (
        <main className='login-layout'>
          <section className='login-intro' aria-label='About Silo'>
            <div className='storage-atmosphere' aria-hidden='true'>
              <svg className='storage-grid' viewBox='0 0 600 700' fill='none'>
                <defs>
                  <pattern id='storage-dots' width='30' height='30' patternUnits='userSpaceOnUse'>
                    <circle cx='15' cy='15' r='1' fill='currentColor' />
                  </pattern>
                  <linearGradient id='storage-trace' x1='0' x2='1'>
                    <stop stopColor='#94baff' stopOpacity='0' />
                    <stop offset='1' stopColor='#94baff' />
                  </linearGradient>
                </defs>
                <path fill='url(#storage-dots)' d='M0 0h600v700H0z' />
                {[105, 225, 345, 465, 585].map((y, index) => (
                  <g
                    key={y}
                    className='storage-trace'
                    style={{ animationDelay: `${index * -1.7}s` }}
                  >
                    <path d={`M-90 ${y}h90`} stroke='url(#storage-trace)' strokeWidth='1.5' />
                    <circle cy={y} r='2.5' fill='#b4d2ff' />
                  </g>
                ))}
              </svg>
            </div>
            <span className='eyebrow'>A clearer view</span>
            <h1>
              Your storage.
              <br />
              <span>In focus.</span>
            </h1>
            <p>Explore your buckets, inspect every object, and find exactly what you need.</p>
            <div className='login-intro-footer'>
              <span>Silo / Storage explorer</span>
            </div>
          </section>
          <section className='login-access'>
            <div className='login-form-wrap'>
              <span className='eyebrow'>Your workspace</span>
              <h2>Sign in to Silo</h2>
              <p className='login-description'>Enter your administrator credentials to continue.</p>
              <form onSubmit={submit} className='login-form'>
                <label>
                  Username
                  <input
                    autoComplete='username'
                    name='username'
                    placeholder='Your username'
                    autoCapitalize='none'
                    spellCheck={false}
                    required
                    value={username}
                    onChange={event => setUsername(event.target.value)}
                    disabled={pending}
                  />
                </label>
                <label>
                  Password
                  <input
                    type='password'
                    autoComplete='current-password'
                    name='password'
                    placeholder='Your password'
                    required
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    disabled={pending}
                  />
                </label>
                {error && (
                  <p className='form-error' role='alert'>
                    {error}
                  </p>
                )}
                <button className='button-primary login-submit' type='submit' disabled={pending}>
                  {pending ? "Signing in…" : "Sign in"}
                  <ArrowRight size={18} aria-hidden />
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
            </div>
          </section>
        </main>
      ) : (
        <Transfers>
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
        </Transfers>
      )}
    </BrowserRouter>
  )
}
