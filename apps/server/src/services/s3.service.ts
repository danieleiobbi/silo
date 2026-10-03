import {
  S3Client,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  ListBucketsCommand
} from "@aws-sdk/client-s3"
import type { readEnv } from "../config/env.js"

export function createS3Service(config: ReturnType<typeof readEnv>) {
  // I use path-style addressing for Garage so bucket names do not require DNS records.
  // I keep SDK calls here: controllers handle HTTP, while this service only handles S3.
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true
  })
  return {
    async deleteObjects(bucket: string, keys: string[]) {
      // I send only the exact selected keys. I never expand a prefix into deletion targets.
      // I preserve per-object failures because S3 can partially accept a batch.
      const xmlKeys: string[] = []
      const otherKeys: string[] = []
      for (const key of keys) {
        // I send control-character keys separately because DeleteObjects embeds keys in XML.
        // XML rejects some characters and normalizes carriage returns, potentially deleting
        // a different object. DeleteObject carries the exact key in the encoded request path.
        const needsPath = [...key].some(
          character =>
            character.codePointAt(0)! < 32 || character === "\uFFFE" || character === "\uFFFF"
        )
        if (needsPath) otherKeys.push(key)
        else xmlKeys.push(key)
      }
      const result = xmlKeys.length
        ? await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: xmlKeys.map(Key => ({ Key })), Quiet: false }
            })
          )
        : { Deleted: [], Errors: [] }
      const deleted = (result.Deleted ?? []).map(item => item.Key!)
      const errors = (result.Errors ?? []).map(item => ({
        key: item.Key!,
        code: item.Code ?? "DeleteFailed"
      }))
      for (const key of otherKeys) {
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
          deleted.push(key)
        } catch (error) {
          errors.push({ key, code: error instanceof Error ? error.name : "DeleteFailed" })
        }
      }
      return { deleted, errors }
    },
    async deleteBucket(bucket: string) {
      // I check for one object without scanning or emptying the bucket. I still rely on
      // DeleteBucket to reject a concurrent write between this check and deletion.
      const contents = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1, EncodingType: "url" })
      )
      if (contents.Contents?.length)
        throw Object.assign(new Error("Bucket is not empty"), { name: "BucketNotEmpty" })
      await client.send(new DeleteBucketCommand({ Bucket: bucket }))
    },
    async search(bucket: string, prefix: string, query: string) {
      // I scan keys because S3 has no substring-search operation. I omit Delimiter to
      // include descendants, cap the work at 1,000 objects and 100 matches, and mark
      // results incomplete whenever either cap leaves objects unexamined.
      const objects: { key: string; size: number; modifiedAt?: Date }[] = []
      let examined = 0
      let token: string | undefined
      do {
        const result = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            EncodingType: "url",
            MaxKeys: 1000 - examined,
            ContinuationToken: token
          })
        )
        const contents = result.Contents ?? []
        for (let index = 0; index < contents.length && examined < 1000; index++) {
          const item = contents[index]
          examined++
          const key = decodeKey(item.Key!, result.EncodingType)
          if (key.toLowerCase().includes(query.toLowerCase()))
            objects.push({ key, size: item.Size ?? 0, modifiedAt: item.LastModified })
          if (objects.length === 100 || examined === 1000)
            return {
              objects,
              examined,
              incomplete: index < contents.length - 1 || Boolean(result.IsTruncated)
            }
        }
        token = result.IsTruncated ? result.NextContinuationToken : undefined
      } while (token)
      return { objects, examined, incomplete: false }
    },
    async details(bucket: string, key: string) {
      const item = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      return {
        key,
        size: item.ContentLength ?? 0,
        modifiedAt: item.LastModified,
        contentType: item.ContentType,
        etag: item.ETag,
        metadata: item.Metadata ?? {},
        cacheControl: item.CacheControl,
        contentDisposition: item.ContentDisposition,
        contentEncoding: item.ContentEncoding,
        contentLanguage: item.ContentLanguage,
        expires: item.Expires,
        storageClass: item.StorageClass
      }
    },
    async download(bucket: string, key: string, signal: AbortSignal) {
      return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: signal
      })
    },
    async listObjects(bucket: string, prefix: string, limit: number, token?: string) {
      // I use Delimiter to show common prefixes as folders without treating them as
      // real directories. I retain zero-byte marker objects so they can be inspected.
      // I pass continuation tokens through unchanged: they are opaque, not offsets.
      const result = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: "/",
          EncodingType: "url",
          MaxKeys: limit,
          ContinuationToken: token
        })
      )
      return {
        prefixes: (result.CommonPrefixes ?? []).map(item =>
          decodeKey(item.Prefix!, result.EncodingType)
        ),
        objects: (result.Contents ?? []).map(item => ({
          key: decodeKey(item.Key!, result.EncodingType),
          size: item.Size ?? 0,
          modifiedAt: item.LastModified
        })),
        nextToken: result.IsTruncated ? result.NextContinuationToken : undefined
      }
    },
    async listBuckets() {
      const result = await client.send(new ListBucketsCommand({}))
      return (result.Buckets ?? []).map(bucket => ({
        name: bucket.Name!,
        createdAt: bucket.CreationDate
      }))
    }
  }
}
export type S3Service = ReturnType<typeof createS3Service>

// I request URL-encoded listings so XML parsing cannot normalize key characters.
// I decode keys and prefixes exactly once, never continuation tokens or metadata.
function decodeKey(key: string, encoding?: string) {
  return encoding === "url" ? decodeURIComponent(key) : key
}
