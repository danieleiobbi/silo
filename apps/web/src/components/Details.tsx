import { Toast } from "./Toast"
import { useEffect, useState, useRef } from "react"
import { api } from "../lib/api"
import { objectsUrl } from "../lib/location"
import type { ObjectItem } from "../pages/Objects"
import { Copy, Download, Trash2, X } from "lucide-react"

type Detail = ObjectItem & {
  contentType?: string
  etag?: string
  metadata: Record<string, string>
  cacheControl?: string
  contentDisposition?: string
  contentEncoding?: string
  contentLanguage?: string
  expires?: string
  storageClass?: string
}
export function Details({
  bucket,
  objectKey,
  onClose,
  onDelete
}: {
  bucket: string
  objectKey: string
  onDelete: () => void
  onClose: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    heading.current?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  const [detail, setDetail] = useState<Detail>()
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    api<Detail>(objectsUrl(bucket, "object", { key: objectKey }), { signal: abort.signal })
      .then(setDetail)
      .catch(error => {
        if (!abort.signal.aborted) setError(error.message)
      })
    return () => abort.abort()
  }, [bucket, objectKey, retry])
  return (
    <aside
      aria-label='Object details'
      onKeyDown={event => {
        if (event.key === "Escape") {
          event.stopPropagation()
          onClose()
        }
      }}
      className='details-panel'
    >
      <div className='details-heading'>
        <h2 ref={heading} tabIndex={-1} className='text-lg font-semibold'>
          Object details
        </h2>
        <button className='button-quiet' onClick={onClose} aria-label='Close object details'>
          <X size={18} aria-hidden />
        </button>
      </div>
      {error ? (
        <p role='alert'>
          {error}{" "}
          <button
            onClick={() => {
              setError("")
              setRetry(retry + 1)
            }}
          >
            Retry
          </button>
        </p>
      ) : !detail ? (
        <p role='status'>Loading details…</p>
      ) : (
        <>
          <dl className='grid gap-3 text-sm'>
            {Object.entries({
              Name: objectKey.split("/").at(-1) || "(folder marker)",
              "Full key": objectKey,
              Size: `${detail.size.toLocaleString()} B`,
              Modified: detail.modifiedAt ? new Date(detail.modifiedAt).toLocaleString() : "—",
              "Content-Type": detail.contentType,
              ETag: detail.etag,
              "Cache-Control": detail.cacheControl,
              "Content-Disposition": detail.contentDisposition,
              "Content-Encoding": detail.contentEncoding,
              "Content-Language": detail.contentLanguage,
              Expires: detail.expires,
              "Storage class": detail.storageClass
            })
              .filter(
                ([name, value]) => value !== undefined || ["Content-Type", "ETag"].includes(name)
              )
              .map(([name, value]) => (
                <div key={name}>
                  <dt className='text-[var(--muted)]'>{name}</dt>
                  <dd
                    className={`mt-1 whitespace-pre-wrap break-all ${name === "Full key" || name === "ETag" ? "object-key" : ""}`}
                  >
                    {value ?? "—"}
                  </dd>
                </div>
              ))}
          </dl>
          <h3 className='mb-2 mt-5 font-medium'>Custom metadata</h3>
          {!Object.keys(detail.metadata).length ? (
            <p className='text-sm'>No custom metadata.</p>
          ) : (
            <dl className='grid gap-2 text-sm'>
              {Object.entries(detail.metadata).map(([key, value]) => (
                <div key={key}>
                  <dt className='break-all font-medium'>{key}</dt>
                  <dd className='break-all'>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className='details-actions'>
            <button
              onClick={async () => {
                try {
                  if (navigator.clipboard) await navigator.clipboard.writeText(objectKey)
                  else {
                    // I support private HTTP deployments where the modern Clipboard API is
                    // unavailable. I select a temporary field, copy on the user's click and
                    // restore focus; I never store the key in browser persistence.
                    const field = document.createElement("textarea")
                    field.value = objectKey
                    field.style.position = "fixed"
                    field.style.opacity = "0"
                    const previous = document.activeElement as HTMLElement | null
                    document.body.append(field)
                    try {
                      field.select()
                      if (!document.execCommand("copy")) throw new Error("Clipboard unavailable")
                    } finally {
                      field.remove()
                      previous?.focus()
                    }
                  }
                  setNotice("Key copied")
                } catch {
                  setNotice("Could not copy. Select the full key and copy it manually.")
                }
              }}
            >
              <Copy size={15} aria-hidden />
              Copy key
            </button>
            <button onClick={onDelete} className='button-danger-quiet'>
              <Trash2 size={15} aria-hidden />
              Delete object
            </button>
            <a
              className='button-primary download-button'
              href={`/api${objectsUrl(bucket, "download", { key: objectKey })}`}
            >
              <Download size={15} aria-hidden />
              Download
            </a>
          </div>
          {notice && <Toast message={notice} onClose={() => setNotice("")} />}
        </>
      )}
    </aside>
  )
}
