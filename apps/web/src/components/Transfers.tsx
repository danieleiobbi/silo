import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { DeleteDialog } from "./DeleteDialog"
import { bucketUrl, objectsUrl } from "../lib/location"
import { api, expireSession, sessionVersion } from "../lib/api"
import {
  keyError,
  nameError,
  newObjectKey,
  MAX_QUEUE_ENTRIES
} from "../../../server/src/lib/write-validation"

type Status =
  | "queued"
  | "uploading"
  | "finalizing"
  | "uploaded"
  | "conflict"
  | "failed"
  | "cancelled"
  | "outcome unknown"
type Entry = {
  id: number
  name: string
  bucket: string
  prefix: string
  key: string
  size: number
  progress: number
  status: Status
  file?: File
  error?: string
  overwrite?: boolean
}
type Candidate = { name: string; file?: File; error?: string }
const TransfersContext = createContext<{
  add: (bucket: string, prefix: string, candidates: Candidate[]) => void
  revision: number
  dirty: ReadonlySet<string>
  maxUploadBytes?: number
} | null>(null)
export function useTransfers() {
  return useContext(TransfersContext)!
}
const running = (entry: Entry) => ["queued", "uploading", "finalizing"].includes(entry.status)

export function Transfers({ children }: { children: ReactNode }) {
  const [maxUploadBytes, setMaxUploadBytes] = useState<number>()
  const [configError, setConfigError] = useState("")
  const [configRetry, setConfigRetry] = useState(0)
  const [entries, setEntries] = useState<Entry[]>([])
  const [revision, setRevision] = useState(0)
  const [confirming, setConfirming] = useState<number>()
  const [rejections, setRejections] = useState<string[]>([])
  const dirty = useRef(new Set<string>())
  const nextId = useRef(0)
  const live = useRef(true)
  const active = useRef<{ id: number; xhr: XMLHttpRequest } | null>(null)
  const awaitingRefresh = useRef(false)
  const [announcement, setAnnouncement] = useState("")
  useEffect(() => {
    const abort = new AbortController()
    setConfigError("")
    api<{ maxUploadBytes: number }>("/config", { signal: abort.signal })
      .then(config => {
        if (!Number.isSafeInteger(config.maxUploadBytes) || config.maxUploadBytes <= 0)
          throw new Error("Invalid upload limit")
        if (!abort.signal.aborted) setMaxUploadBytes(config.maxUploadBytes)
      })
      .catch(() => {
        if (!abort.signal.aborted) setConfigError("Unable to load the upload limit. Try again.")
      })
    return () => abort.abort()
  }, [configRetry])
  useEffect(() => {
    live.current = true
    const preventDrop = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault()
    }
    window.addEventListener("dragover", preventDrop)
    window.addEventListener("drop", preventDrop)
    return () => {
      live.current = false
      active.current?.xhr.abort()
      active.current = null
      window.removeEventListener("dragover", preventDrop)
      window.removeEventListener("drop", preventDrop)
    }
  }, [])
  const pending = entries.some(running)
  useEffect(() => {
    if (!pending) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [pending])

  useEffect(() => {
    if (active.current || !live.current) return
    const entry = entries.find(item => item.status === "queued")
    if (!entry) {
      if (awaitingRefresh.current) {
        awaitingRefresh.current = false
        setRevision(value => value + 1)
      }
      return
    }
    if (!awaitingRefresh.current) dirty.current.clear()
    const version = sessionVersion()
    const xhr = new XMLHttpRequest()
    active.current = { id: entry.id, xhr }
    const current = () =>
      live.current && sessionVersion() === version && active.current?.xhr === xhr
    const update = (change: Partial<Entry>) => {
      if (current())
        setEntries(items =>
          items.map(item => (item.id === entry.id ? { ...item, ...change } : item))
        )
    }
    const settle = (status: Status, error?: string) => {
      if (!current()) return
      dirty.current.add(JSON.stringify([entry.bucket, entry.prefix]))
      awaitingRefresh.current = true
      update({
        status,
        error,
        overwrite: false,
        file: status === "uploaded" || status === "cancelled" ? undefined : entry.file
      })
      setAnnouncement(`${entry.name}: ${status}${error ? `. ${error}` : ""}`)
      active.current = null
    }
    xhr.open(
      "PUT",
      `/api${objectsUrl(entry.bucket, "object", { key: entry.key, size: String(entry.size), ...(entry.overwrite ? { overwrite: "true" } : {}) })}`
    )
    xhr.setRequestHeader("Content-Type", "application/octet-stream")
    xhr.timeout = 5 * 60 * 1000
    xhr.upload.onprogress = event => {
      const percent =
        event.lengthComputable && event.total
          ? Math.min(100, Math.round((event.loaded / event.total) * 100))
          : entry.size === 0
            ? 100
            : 0
      update({ progress: percent, status: percent === 100 ? "finalizing" : "uploading" })
    }
    xhr.upload.onload = () => update({ progress: 100, status: "finalizing" })
    xhr.onload = () => {
      if (!current()) return
      if (xhr.status === 401) {
        expireSession()
        return
      }
      let result: { error?: string; code?: string; key?: string; size?: number } = {}
      try {
        result = JSON.parse(xhr.responseText)
      } catch {
        /* I keep an unreadable upstream response ambiguous. */
      }
      if (xhr.status === 201 && result.key === entry.key && result.size === entry.size)
        settle("uploaded")
      else if (xhr.status === 409 && result.code === "ObjectAlreadyExists")
        settle(
          "conflict",
          "This file already exists and will be overwritten. Confirm overwrite to continue."
        )
      else if (xhr.status >= 500 || xhr.status === 0 || xhr.status === 201)
        settle("outcome unknown", result.error ?? "Inspect the destination before retrying.")
      else settle("failed", result.error ?? "Upload failed. Retry explicitly.")
    }
    xhr.onerror = () =>
      settle("outcome unknown", "Connection lost. Inspect the destination before retrying.")
    xhr.ontimeout = () =>
      settle("outcome unknown", "Upload timed out. Inspect the destination before retrying.")
    xhr.onabort = () => {
      if (!current()) return
      settle(
        "outcome unknown",
        "Upload cancelled; it may already be stored. Inspect the destination."
      )
      if (live.current)
        setEntries(items =>
          items.map(item => (item.id === entry.id ? { ...item, file: undefined } : item))
        )
    }
    update({ status: "uploading", error: undefined })
    xhr.send(entry.file!)
  }, [entries])

  function add(bucket: string, prefix: string, candidates: Candidate[]) {
    if (maxUploadBytes === undefined) {
      setRejections(["Upload settings are not ready. Try again after the limit has loaded."])
      return
    }
    const rejected: string[] = []
    const next = [...entries]
    for (const candidate of candidates) {
      const key = newObjectKey(prefix, candidate.name)
      const error =
        candidate.error ??
        nameError(candidate.name) ??
        keyError(key) ??
        (candidate.file && candidate.file.size > maxUploadBytes
          ? `File exceeds ${maxUploadBytes / (1024 * 1024)} MiB`
          : undefined) ??
        (next.some(item => item.bucket === bucket && item.key === key)
          ? "Destination is already retained in the queue"
          : undefined)
      if (next.length >= MAX_QUEUE_ENTRIES) {
        rejected.push(`${candidate.name}: queue capacity is 100. Remove completed entries first.`)
        continue
      }
      next.push({
        id: nextId.current++,
        name: candidate.name,
        bucket,
        prefix,
        key,
        size: candidate.file?.size ?? 0,
        progress: 0,
        status: error ? "failed" : "queued",
        error,
        file: error ? undefined : candidate.file
      })
    }
    setEntries(next)
    // I show capacity rejections individually without retaining additional File references.
    if (rejected.length) setRejections(rejected)
  }
  function cancel(entry: Entry) {
    if (active.current?.id === entry.id) active.current.xhr.abort()
    else
      setEntries(items =>
        items.map(item =>
          item.id === entry.id
            ? { ...item, status: "cancelled", file: undefined, overwrite: false }
            : item
        )
      )
  }
  const confirm = entries.find(entry => entry.id === confirming)
  return (
    <TransfersContext.Provider value={{ add, revision, dirty: dirty.current, maxUploadBytes }}>
      {children}
      {configError && (
        <div className='workspace' role='alert'>
          <p>{configError}</p>
          <button onClick={() => setConfigRetry(value => value + 1)}>Retry upload settings</button>
        </div>
      )}
      {(entries.length > 0 || rejections.length > 0) && (
        <section className='workspace transfer-workspace' aria-label='File transfers'>
          <div className='data-surface transfer-panel'>
            <div className='surface-heading'>
              <h2>Transfers</h2>
              <span className='count-badge'>
                {entries.filter(entry => entry.status === "uploaded").length}/{entries.length}{" "}
                uploaded
              </span>
            </div>
            <p className='transfer-help'>
              Existing files require overwrite confirmation. A different client can change a
              destination after the check. Progress shows bytes sent; completion waits for storage.
            </p>
            {entries.map(entry => (
              <div className='transfer-row' key={entry.id}>
                <div className='min-w-0'>
                  <strong>{entry.name}</strong>
                  <Link
                    className='exact-destination'
                    to={bucketUrl(entry.bucket, entry.key.slice(0, entry.key.lastIndexOf("/") + 1))}
                  >
                    {entry.bucket}/{entry.key}
                  </Link>
                  <span>{entry.size.toLocaleString()} bytes</span>
                </div>
                <div className='min-w-0'>
                  <span>
                    {entry.status === "finalizing"
                      ? "Finishing upload"
                      : entry.status === "conflict"
                        ? "Overwrite confirmation required"
                        : entry.status}
                  </span>
                  {running(entry) && (
                    <progress
                      max={100}
                      value={entry.progress}
                      aria-label={`Upload progress for ${entry.name}`}
                    />
                  )}
                  {entry.error && <p>{entry.error}</p>}
                </div>
                <div className='transfer-actions'>
                  {running(entry) ? (
                    <button onClick={() => cancel(entry)}>Cancel</button>
                  ) : (
                    <>
                      {entry.status === "conflict" && entry.file && (
                        <button className='button-danger' onClick={() => setConfirming(entry.id)}>
                          Review overwrite
                        </button>
                      )}
                      {["failed", "outcome unknown"].includes(entry.status) && entry.file && (
                        <button
                          onClick={() =>
                            setEntries(items =>
                              items.map(item =>
                                item.id === entry.id
                                  ? {
                                      ...item,
                                      status: "queued",
                                      overwrite: false,
                                      progress: 0,
                                      error: undefined
                                    }
                                  : item
                              )
                            )
                          }
                        >
                          Retry
                        </button>
                      )}
                      <button
                        onClick={() =>
                          setEntries(items => items.filter(item => item.id !== entry.id))
                        }
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {rejections.length > 0 && (
              <div className='transfer-help' role='alert'>
                <ul>
                  {rejections.map((message, index) => (
                    <li key={index}>{message}</li>
                  ))}
                </ul>
                <button onClick={() => setRejections([])}>Dismiss rejected files</button>
              </div>
            )}
          </div>
        </section>
      )}
      <p className='sr-only' role='status' aria-live='polite'>
        {announcement}
      </p>
      {confirm && (
        <DeleteDialog
          title='Overwrite this file?'
          warning='This file already exists and will be overwritten. Its current contents will be replaced. This action cannot be undone.'
          confirmLabel='Overwrite file'
          keys={[`${confirm.bucket}/${confirm.key}`]}
          onClose={() => setConfirming(undefined)}
          onConfirm={async () => {
            setEntries(items =>
              items.map(item =>
                item.id === confirm.id
                  ? { ...item, status: "queued", overwrite: true, progress: 0, error: undefined }
                  : item
              )
            )
          }}
        />
      )}
    </TransfersContext.Provider>
  )
}
