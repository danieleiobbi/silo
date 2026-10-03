import { Toast } from "../components/Toast"
import { DeleteDialog } from "../components/DeleteDialog"
import { Details } from "../components/Details"
import { useEffect, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { Folder, File } from "lucide-react"
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
    <main className='mx-auto max-w-[1500px] p-4 sm:p-8'>
      <div
        className={selected !== undefined ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]" : ""}
      >
        <section className='min-w-0'>
          <nav aria-label='Breadcrumb' className='mb-6 flex flex-wrap items-center gap-2 text-sm'>
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
          <div className='mb-4 flex items-center justify-between gap-3'>
            <h1 className='min-w-0 truncate text-xl font-semibold'>{segments.at(-1) || bucket}</h1>
            <button onClick={reload}>Refresh</button>
          </div>
          {notice && <Toast message={notice} onClose={() => setNotice("")} />}
          {selectedKeys.length > 0 && (
            <div className='mb-3 flex items-center gap-3 text-sm'>
              <span>{selectedKeys.length} selected on this page</span>
              <button
                className='text-[var(--destructive)]'
                onClick={() => setDeleting(selectedKeys)}
              >
                Delete selected
              </button>
            </div>
          )}
          <form
            className='mb-4 flex flex-wrap gap-2'
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
            <input
              id='search'
              autoComplete='off'
              className='min-w-0 flex-1 rounded-md border border-[var(--border)] px-3 py-2 text-sm'
              value={input}
              onChange={event => setInput(event.target.value)}
              placeholder='Search keys in this prefix (3+ characters)'
            />
            <button disabled={[...input].length < 3}>Search</button>
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
            <div role='alert'>
              {error} <button onClick={reload}>Retry</button>
            </div>
          ) : !visible ? (
            <p role='status'>Loading objects…</p>
          ) : (
            <>
              {!visible.prefixes.length && !visible.objects.length ? (
                <p>{query ? "No matching keys in this prefix." : "No objects in this prefix."}</p>
              ) : (
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
                      <tr key={item.key}>
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
                            className='flex max-w-full items-center gap-2 border-0 p-0 text-left'
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
              )}
            </>
          )}
          <footer className='mt-4 flex flex-wrap items-center justify-between gap-3 text-sm'>
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
