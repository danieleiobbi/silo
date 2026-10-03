import { useEffect } from "react"
export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 7000)
    return () => clearTimeout(timer)
  }, [message, onClose])
  return (
    <div
      role='status'
      className='toast fixed bottom-5 right-5 z-50 flex max-h-48 max-w-[calc(100vw-2.5rem)] items-start gap-4 overflow-auto rounded-lg border border-[var(--border)] p-4 text-sm'
    >
      <span className='whitespace-pre-wrap break-all'>{message}</span>
      <button aria-label='Dismiss notification' onClick={onClose}>
        Close
      </button>
    </div>
  )
}
