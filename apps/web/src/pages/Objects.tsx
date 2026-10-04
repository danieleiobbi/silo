import { CreateDialog } from "../components/CreateDialog"
import { useTransfers } from "../components/Transfers"
import { destinationBase } from "../../../server/src/lib/write-validation"
import { Toast } from "../components/Toast"
import { DeleteDialog } from "../components/DeleteDialog"
import { Details } from "../components/Details"
import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { Folder, File, RefreshCw, Search, Trash2, ArrowLeft, ArrowRight } from "lucide-react"
import { api } from "../lib/api"
import { bucketUrl, objectsUrl } from "../lib/location"

export type ObjectItem = { key: string; size: number; modifiedAt?: string }
type SearchResult = { objects: ObjectItem[]; examined: number; incomplete: boolean }
type Listing = { prefixes: string[]; objects: ObjectItem[]; nextToken?: string }

export function ObjectsRoute() {
  const { bucket = "" } = useParams()
  const [query] = useSearchParams()
  const prefix = query.get("prefix") ?? ""
  // I reset search, pagination and selection when the URL location changes,
  // including Back/Forward, so state from one prefix cannot affect another.
  return <Objects key={JSON.stringify([bucket, prefix])} bucket={bucket} prefix={prefix} />
}

function Objects({ bucket, prefix }: { bucket: string; prefix: string }) {
  const navigate = useNavigate()
  const transfers = useTransfers()
  const [creating, setCreating] = useState(false)
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const picker = useRef<HTMLInputElement>(null)
  const seenRevision = useRef(transfers.revision)
  const [checked, setChecked] = useState<string[]>([])
  const [deleting, setDeleting] = useState<string[]>()
  const [notice, setNotice] = useState("")
  const [input, setInput] = useState("")
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState<SearchResult>()
  const [searchPage, setSearchPage] = useState(0)
  const [selected, setSelected] = useState<string>()
  const [limit, setLimit] = useState(50)
  // I keep the input token for each visited S3 page. Previous reuses an earlier
  // token without inventing offsets or rescanning pages to find their boundaries.
  const [tokens, setTokens] = useState<(string | undefined)[]>([undefined])
  const [listing, setListing] = useState<Listing>()
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(0)
  const token = tokens[tokens.length - 1]
  // I paginate bounded search results locally. Page size must not trigger another scan.
  const requestUrl = query
    ? objectsUrl(bucket, "search", { prefix, query })
    : objectsUrl(bucket, "objects", { prefix, limit: String(limit), ...(token ? { token } : {}) })
  useEffect(() => {
    const abort = new AbortController()
    if (query) {
      api<SearchResult>(requestUrl, { signal: abort.signal })
        .then(setSearch)
        .catch(error => {
          if (!abort.signal.aborted) setError(error.message)
        })
      return () => abort.abort()
    }
    api<Listing>(requestUrl, { signal: abort.signal })
      .then(setListing)
      .catch(error => {
        if (!abort.signal.aborted) setError(error.message)
      })
    return () => abort.abort()
  }, [requestUrl, refresh, query])
  useEffect(() => {
    if (seenRevision.current === transfers.revision) return
    seenRevision.current = transfers.revision
    if (query || !transfers.dirty.has(JSON.stringify([bucket, prefix]))) return
    setChecked([])
    setListing(undefined)
    setSelected(undefined)
    setError("")
    setTokens([undefined])
    setRefresh(value => value + 1)
  }, [transfers.revision, transfers.dirty, query, bucket, prefix])
  function reload() {
    setChecked([])
    setListing(undefined)
    setSearch(undefined)
    setSearchPage(0)
    setSelected(undefined)
    setError("")
    setTokens([undefined])
    setRefresh(value => value + 1)
  }
  const visible = query
    ? search && {
        prefixes: [],
        objects: search.objects.slice(searchPage * limit, (searchPage + 1) * limit)
      }
    : listing
  // I intersect selection with the visible page as a final safeguard. I also clear
  // it on page, size, prefix and search changes; Select all never means the whole bucket.
  const selectedKeys =
    visible?.objects.filter(item => checked.includes(item.key)).map(item => item.key) ?? []
  const segments = prefix.split("/")
  if (segments.at(-1) === "") segments.pop()
  return (
    <main
      className='workspace object-drop-workspace'
      onDragEnter={event => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault()
          depth.current++
          setDragging(true)
        }
      }}
      onDragOver={event => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault()
          event.dataTransfer.dropEffect = query ? "none" : "copy"
        }
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1)
        if (!depth.current) setDragging(false)
      }}
      onDrop={event => {
        if (!event.dataTransfer.types.includes("Files")) return
        event.preventDefault()
        depth.current = 0
        setDragging(false)
        if (query) {
          setNotice("Exit search to upload or create a folder")
          return
        }
        transfers.add(
          bucket,
          prefix,
          Array.from(event.dataTransfer.items)
            .filter(item => item.kind === "file")
            .map(item => {
              const file = item.getAsFile()
              const entry =
                typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null
              if (!entry || !file || entry.isDirectory)
                return {
                  name: entry?.name ?? file?.name ?? "Dropped item",
                  error: entry?.isDirectory
                    ? "Directory upload is not supported"
                    : "Unable to verify this dropped file. Use the file picker."
                }
              return { name: file.name, file }
            })
        )
      }}
    >
      {dragging && (
        <div className='drop-overlay'>
          <strong>
            {query ? "Exit search to upload or create a folder" : "Drop files to upload"}
          </strong>
          <span>
            {bucket}/{destinationBase(prefix)}
          </span>
        </div>
      )}
      <input
        ref={picker}
        className='sr-only'
        type='file'
        multiple
        tabIndex={-1}
        aria-label='Choose files to upload'
        onChange={event => {
          if (!query)
            transfers.add(
              bucket,
              prefix,
              Array.from(event.target.files ?? []).map(file => ({ name: file.name, file }))
            )
          event.target.value = ""
        }}
      />
      <div className={selected !== undefined ? "object-layout with-details" : "object-layout"}>
        <section className='min-w-0'>
          <nav aria-label='Breadcrumb' className='breadcrumbs'>
            <Link to='/buckets'>Buckets</Link>
            <span>/</span>
            <Link to={bucketUrl(bucket)}>{bucket}</Link>
            {segments.map((segment, index) => (
              <span key={index} className='flex min-w-0 gap-2 break-all'>
                <span>/</span>
                <Link to={bucketUrl(bucket, segments.slice(0, index + 1).join("/") + "/")}>
                  {segment || "(empty)"}
                </Link>
              </span>
            ))}
          </nav>
          <div className='page-heading'>
            <div className='min-w-0'>
              <span className='eyebrow'>{prefix ? "Prefix" : "Bucket"}</span>
              <h1 className='truncate'>{segments.at(-1) || bucket}</h1>
              <p>Browse objects and inspect their details.</p>
            </div>
            <div className='flex flex-wrap gap-2'>
              <button
                className='button-primary'
                disabled={Boolean(query)}
                aria-describedby='write-destination'
                onClick={() => picker.current?.click()}
              >
                Upload files
              </button>
              <button
                disabled={Boolean(query)}
                aria-describedby='write-destination'
                onClick={() => setCreating(true)}
              >
                Create folder
              </button>
              <button onClick={reload}>
                <RefreshCw size={15} aria-hidden />
                Refresh
              </button>
            </div>
          </div>
          <p id='write-destination' className='write-destination'>
            {query
              ? "Exit search to upload or create a folder"
              : `Destination: ${bucket}/${destinationBase(prefix)}`}
          </p>
          {notice && <Toast message={notice} onClose={() => setNotice("")} />}
          {selectedKeys.length > 0 && (
            <div className='selection-bar'>
              <span>{selectedKeys.length} selected on this page</span>
              <button className='button-danger-quiet' onClick={() => setDeleting(selectedKeys)}>
                <Trash2 size={15} aria-hidden />
                Delete selected
              </button>
            </div>
          )}
          <form
            className='search-toolbar'
            onSubmit={event => {
              event.preventDefault()
              if ([...input].length < 3) return
              setQuery(input)
              reload()
            }}
          >
            <label className='sr-only' htmlFor='search'>
              Search keys in this prefix
            </label>
            <div className='search-field'>
              <Search size={17} aria-hidden />
              <input
                id='search'
                autoComplete='off'
                value={input}
                onChange={event => setInput(event.target.value)}
                placeholder='Search keys in this prefix (3+ characters)'
              />
            </div>
            <button className='button-primary' disabled={[...input].length < 3}>
              Search
            </button>
            {query && (
              <button
                type='button'
                onClick={() => {
                  setQuery("")
                  setInput("")
                  reload()
                }}
              >
                Clear
              </button>
            )}
          </form>
          {query && search && (
            <p className='mb-3 text-sm' role='status'>
              {search.objects.length} matches · {search.examined} objects examined
              {search.incomplete && (
                <strong className='block'>
                  Results are incomplete. Use a more specific query or prefix.
                </strong>
              )}
            </p>
          )}
          {error ? (
            <div className='state-panel state-error' role='alert'>
              {error} <button onClick={reload}>Retry</button>
            </div>
          ) : !visible ? (
            <p className='state-panel' role='status'>
              Loading objects…
            </p>
          ) : (
            <>
              {!visible.prefixes.length && !visible.objects.length ? (
                <p className='state-panel'>
                  {query ? "No matching keys in this prefix." : "No objects in this prefix."}
                </p>
              ) : (
                <div className='data-surface'>
                  <table>
                    <thead>
                      <tr>
                        <th className='w-10'>
                          <input
                            type='checkbox'
                            aria-label='Select all objects on this page'
                            disabled={!visible.objects.length}
                            checked={
                              visible.objects.length > 0 &&
                              selectedKeys.length === visible.objects.length
                            }
                            onChange={event =>
                              setChecked(
                                event.target.checked ? visible.objects.map(item => item.key) : []
                              )
                            }
                          />
                        </th>
                        <th>Name</th>
                        <th className='hidden sm:table-cell'>Size</th>
                        <th className='hidden md:table-cell'>Modified</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.prefixes.map(item => (
                        <tr key={`prefix:${item}`}>
                          <td />
                          <td>
                            <Link className='flex items-center gap-2' to={bucketUrl(bucket, item)}>
                              <Folder size={16} aria-hidden />
                              {item.slice(prefix.length)}
                            </Link>
                          </td>
                          <td className='hidden sm:table-cell'>—</td>
                          <td className='hidden md:table-cell'>—</td>
                        </tr>
                      ))}
                      {visible.objects.map(item => (
                        <tr
                          key={item.key}
                          data-selected={selected === item.key || selectedKeys.includes(item.key)}
                        >
                          <td>
                            <input
                              type='checkbox'
                              aria-label={`Select ${item.key}`}
                              checked={selectedKeys.includes(item.key)}
                              onChange={event =>
                                setChecked(
                                  event.target.checked
                                    ? [...selectedKeys, item.key]
                                    : selectedKeys.filter(key => key !== item.key)
                                )
                              }
                            />
                          </td>
                          <td>
                            <button
                              className='object-name'
                              aria-pressed={selected === item.key}
                              onClick={() => setSelected(item.key)}
                            >
                              <File size={16} aria-hidden />
                              {item.key.slice(prefix.length) || "(folder marker)"}
                            </button>
                          </td>
                          <td className='hidden sm:table-cell'>{item.size.toLocaleString()} B</td>
                          <td className='hidden md:table-cell'>
                            {item.modifiedAt ? new Date(item.modifiedAt).toLocaleString() : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          <footer className='table-footer'>
            <label>
              Rows{" "}
              <select
                value={limit}
                onChange={event => {
                  setChecked([])
                  setSelected(undefined)
                  setLimit(Number(event.target.value))
                  setSearchPage(0)
                  setTokens([undefined])
                  setListing(undefined)
                  setError("")
                }}
              >
                {[25, 50, 100].map(size => (
                  <option key={size}>{size}</option>
                ))}
              </select>
            </label>
            <div className='flex gap-2'>
              <button
                disabled={!visible || (query ? searchPage === 0 : tokens.length === 1)}
                onClick={() => {
                  setChecked([])
                  setSelected(undefined)
                  if (query) {
                    setSearchPage(searchPage - 1)
                    return
                  }
                  setTokens(tokens.slice(0, -1))
                  setListing(undefined)
                }}
              >
                <ArrowLeft size={14} aria-hidden />
                Previous
              </button>
              <button
                disabled={
                  !visible ||
                  (query
                    ? (searchPage + 1) * limit >= (search?.objects.length ?? 0)
                    : !listing?.nextToken)
                }
                onClick={() => {
                  setChecked([])
                  setSelected(undefined)
                  if (query) {
                    setSearchPage(searchPage + 1)
                    return
                  }
                  setTokens([...tokens, listing!.nextToken])
                  setListing(undefined)
                }}
              >
                Next
                <ArrowRight size={14} aria-hidden />
              </button>
            </div>
          </footer>
        </section>
        {selected !== undefined && (
          <Details
            key={selected}
            bucket={bucket}
            objectKey={selected}
            onDelete={() => setDeleting([selected])}
            onClose={() => setSelected(undefined)}
          />
        )}
      </div>
      {creating && (
        <CreateDialog
          bucket={bucket}
          prefix={prefix}
          onClose={() => setCreating(false)}
          onCreated={result => navigate(bucketUrl(bucket, result.prefix!))}
        />
      )}
      {deleting && (
        <DeleteDialog
          title={
            deleting.length === 1 ? "Delete this object?" : `Delete ${deleting.length} objects?`
          }
          keys={deleting}
          onClose={() => setDeleting(undefined)}
          onConfirm={async () => {
            const result = await api<{
              deleted: string[]
              errors: { key: string; code: string }[]
            }>(objectsUrl(bucket, "objects"), {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ keys: deleting })
            })
            reload()
            setNotice(
              result.errors.length
                ? `${result.deleted.length} deleted; ${result.errors.length} failed. ${result.errors.map(item => `${item.key}: ${item.code}`).join("; ")}`
                : `${result.deleted.length} objects deleted`
            )
          }}
        />
      )}
    </main>
  )
}
