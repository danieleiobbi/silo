// I store the prefix in the query because URL paths normalize "." and "..".
// I use URLSearchParams to preserve repeated slashes, percent signs, plus signs,
// hashes and Unicode exactly, without treating any part of an S3 key as a URL path.
export function bucketUrl(bucket: string, prefix = "") {
  const query = new URLSearchParams({ prefix })
  return `/buckets/${encodeURIComponent(bucket)}${prefix ? `?${query}` : ""}`
}
export function objectsUrl(bucket: string, action: string, values: Record<string, string> = {}) {
  return `/buckets/${encodeURIComponent(bucket)}/${action}?${new URLSearchParams(values)}`
}
