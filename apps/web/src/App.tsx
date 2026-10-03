import { Theme } from "./components/Theme"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { ObjectsRoute } from "./pages/Objects"
import { Buckets } from "./pages/Buckets"

export function App() {
  return (
    <BrowserRouter>
      <header className='flex h-16 items-center justify-between border-b border-[var(--border)] px-4 font-semibold tracking-tight sm:px-8'>
        <a href='/buckets' className='text-lg'>
          Silo
          <span className='ml-3 text-xs font-normal tracking-normal text-[var(--muted)]'>
            Object storage
          </span>
        </a>
        <Theme />
      </header>
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
    </BrowserRouter>
  )
}
