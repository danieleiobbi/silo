import { Component, type ReactNode } from "react"

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed)
      return (
        <main className='mx-auto max-w-xl p-8'>
          <h1 className='mb-4 text-xl font-semibold'>Something went wrong</h1>
          <p className='mb-4'>Reload Silo to recover.</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </main>
      )
    return this.props.children
  }
}
