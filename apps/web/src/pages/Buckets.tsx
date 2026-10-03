import { DeleteDialog } from "../components/DeleteDialog"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { api } from "../lib/api"

type Bucket = { name: string; createdAt?: string }
export function Buckets() {
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
    <main className='mx-auto max-w-7xl p-6'>
      <div className='mb-6 flex items-center justify-between'>
        <h1 className='text-xl font-semibold'>Buckets</h1>
        <button
          onClick={() => {
            setError("")
            setBuckets(undefined)
            setRefresh(refresh + 1)
          }}
        >
          Refresh
        </button>
      </div>
      {error ? (
        <div role='alert'>
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
        <p role='status'>Loading buckets…</p>
      ) : !buckets.length ? (
        <p>No accessible buckets.</p>
      ) : (
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
                  <Link to={`/buckets/${encodeURIComponent(bucket.name)}`}>{bucket.name}</Link>
                </td>
                <td className='hidden sm:table-cell'>
                  {bucket.createdAt ? new Date(bucket.createdAt).toLocaleString() : "—"}
                </td>
                <td className='text-right'>
                  <button
                    onClick={() => setDeleting(bucket.name)}
                    aria-label={`Delete bucket ${bucket.name}`}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
