import { useEffect, useRef, useState } from "react"

export function DeleteDialog({
  title,
  keys,
  bucketName,
  warning,
  confirmLabel = "Delete",
  onConfirm,
  onClose
}: {
  title: string
  keys?: string[]
  bucketName?: string
  warning?: string
  confirmLabel?: string
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [confirmation, setConfirmation] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    // I use a native modal dialog for focus trapping, Escape and background isolation.
    // I restore focus only if the original control still exists after a deletion.
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current!
    element.showModal()
    return () => {
      element.close()
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      aria-labelledby='delete-title'
      aria-describedby='delete-warning'
      onCancel={event => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      className='delete-dialog'
    >
      <h2 id='delete-title' className='text-lg font-semibold'>
        {title}
      </h2>
      <p id='delete-warning' className='my-4 text-sm'>
        {warning ?? "This action cannot be undone."}
        {bucketName && " Only an empty bucket can be deleted."}
      </p>
      {keys && (
        <ul className='mb-4 max-h-40 overflow-auto text-sm'>
          {keys.map(key => (
            <li key={key} className='whitespace-pre-wrap break-all py-1'>
              {key}
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={async event => {
          event.preventDefault()
          if (busy || (bucketName !== undefined && confirmation !== bucketName)) return
          setBusy(true)
          setError("")
          try {
            await onConfirm()
            onClose()
          } catch (error) {
            setError(error instanceof Error ? error.message : "Deletion failed")
            setBusy(false)
          }
        }}
      >
        {bucketName !== undefined && (
          <label className='block text-sm'>
            Type <strong className='break-all'>{bucketName}</strong> to confirm
            <input
              className='mt-2 w-full rounded border border-[var(--border)] p-2'
              autoComplete='off'
              spellCheck={false}
              value={confirmation}
              onChange={event => setConfirmation(event.target.value)}
              disabled={busy}
            />
          </label>
        )}
        {error && (
          <p role='alert' className='my-3 text-sm text-[var(--destructive)]'>
            {error}
          </p>
        )}
        <div className='mt-5 flex justify-end gap-2'>
          <button type='button' autoFocus disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className='button-danger'
            disabled={busy || (bucketName !== undefined && confirmation !== bucketName)}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  )
}
