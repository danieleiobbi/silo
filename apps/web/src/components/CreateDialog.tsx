import { useEffect, useRef, useState } from "react"
import { api } from "../lib/api"
import {
  bucketNameError,
  keyError,
  nameError,
  newObjectKey,
  destinationBase
} from "../../../server/src/lib/write-validation"
import { objectsUrl } from "../lib/location"

export function CreateDialog({
  bucket,
  prefix = "",
  onClose,
  onCreated
}: {
  bucket?: string
  prefix?: string
  onClose: () => void
  onCreated: (result: { name?: string; key?: string; prefix?: string }) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [touched, setTouched] = useState(false)
  const folder = bucket !== undefined
  const key = newObjectKey(prefix, name, true)
  const invalid = folder ? (nameError(name, true) ?? keyError(key)) : bucketNameError(name)
  useEffect(() => {
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
      className='delete-dialog'
      aria-labelledby='create-title'
      onCancel={event => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id='create-title'>Create {folder ? "folder" : "bucket"}</h2>
      <form
        className='creation-form'
        onSubmit={async event => {
          event.preventDefault()
          setTouched(true)
          if (busy || invalid) return
          setBusy(true)
          setError("")
          try {
            const result = await api<{ name?: string; key?: string; prefix?: string }>(
              folder ? objectsUrl(bucket!, "folders") : "/buckets",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(folder ? { prefix, name } : { name })
              }
            )
            onCreated(result)
            onClose()
          } catch (error) {
            setError(error instanceof Error ? error.message : "Creation failed")
            setBusy(false)
          }
        }}
      >
        <label htmlFor='create-name'>{folder ? "Folder" : "Bucket"} name</label>
        <input
          id='create-name'
          autoFocus
          autoComplete='off'
          spellCheck={false}
          disabled={busy}
          value={name}
          onBlur={() => setTouched(true)}
          onChange={event => {
            setName(event.target.value)
            setError("")
          }}
          aria-describedby='create-help create-error'
          aria-invalid={Boolean(touched && invalid)}
        />
        <p id='create-help'>
          {folder
            ? "Enter one folder name. Spaces and Unicode are preserved exactly."
            : "Use 3–63 lowercase letters, digits or hyphens. Reserved names are not allowed."}
        </p>
        {folder && (
          <p className='exact-destination'>
            Destination: {bucket}/{name ? key : `${destinationBase(prefix)}[folder name]/`}
          </p>
        )}
        <p id='create-error' role='alert' className='text-[var(--destructive)]'>
          {error || (touched && invalid)}
        </p>
        <div className='flex justify-end gap-2'>
          <button type='button' disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className='button-primary' disabled={busy || Boolean(invalid)}>
            {busy ? "Creating…" : `Create ${folder ? "folder" : "bucket"}`}
          </button>
        </div>
      </form>
    </dialog>
  )
}
