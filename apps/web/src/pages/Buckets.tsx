import { CreateDialog } from "../components/CreateDialog"
import { DeleteDialog } from "../components/DeleteDialog"
import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { api } from "../lib/api"
import { ArrowUpRight, Database, RefreshCw, Trash2 } from "lucide-react"

type Bucket = { name: string; createdAt?: string }
export function Buckets() {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string>()
  const [buckets, setBuckets] = useState<Bucket[]>()
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    api<Bucket[]>("/buckets", { signal: abort.signal })
      .then(setBuckets)
      .catch(error => {
        if (!abort.signal.aborted) setError(error.message)
      })
    return () => abort.abort()
  }, [refresh])
  return (
    <main className='workspace buckets-workspace'>
      <div className='page-heading'>
        <div>
          <span className='eyebrow'>Storage explorer</span>
          <h1>Buckets</h1>
          <p>Choose a bucket to explore its objects.</p>
        </div>
        <div className='flex flex-wrap gap-2'>
          <button className='button-primary' onClick={() => setCreating(true)}>
            Create bucket
          </button>
          <button
            onClick={() => {
              setError("")
              setBuckets(undefined)
              setRefresh(refresh + 1)
            }}
          >
            <RefreshCw size={15} aria-hidden />
            Refresh
          </button>
        </div>
      </div>
      {error ? (
        <div className='state-panel state-error' role='alert'>
          {error}{" "}
          <button
            onClick={() => {
              setError("")
              setRefresh(refresh + 1)
            }}
          >
            Retry
          </button>
        </div>
      ) : !buckets ? (
        <p className='state-panel' role='status'>
          Loading buckets…
        </p>
      ) : !buckets.length ? (
        <div className='state-panel'>
          <h2>No accessible buckets</h2>
          <p>No buckets were returned by your storage connection.</p>
        </div>
      ) : (
        <div className='data-surface'>
          <div className='surface-heading'>
            <h2>Available buckets</h2>
            <span className='count-badge'>{buckets.length}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th className='hidden sm:table-cell'>Created</th>
                <th>
                  <span className='sr-only'>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {buckets.map(bucket => (
                <tr key={bucket.name}>
                  <td>
                    <Link
                      className='bucket-link'
                      to={`/buckets/${encodeURIComponent(bucket.name)}`}
                    >
                      <span className='bucket-symbol'>
                        <Database size={19} aria-hidden />
                      </span>
                      <span>{bucket.name}</span>
                      <ArrowUpRight className='row-arrow' size={16} aria-hidden />
                    </Link>
                  </td>
                  <td className='hidden sm:table-cell'>
                    {bucket.createdAt ? new Date(bucket.createdAt).toLocaleString() : "—"}
                  </td>
                  <td className='text-right'>
                    <button
                      className='button-danger-quiet'
                      onClick={() => setDeleting(bucket.name)}
                      aria-label={`Delete bucket ${bucket.name}`}
                    >
                      <Trash2 size={15} aria-hidden />
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={result => {
            setRefresh(value => value + 1)
            navigate(`/buckets/${encodeURIComponent(result.name!)}`)
          }}
        />
      )}
      {deleting !== undefined && (
        <DeleteDialog
          title='Delete bucket?'
          bucketName={deleting}
          onClose={() => setDeleting(undefined)}
          onConfirm={async () => {
            await api(`/buckets/${encodeURIComponent(deleting)}`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ confirmation: deleting })
            })
            setBuckets(undefined)
            setRefresh(value => value + 1)
          }}
        />
      )}
    </main>
  )
}
