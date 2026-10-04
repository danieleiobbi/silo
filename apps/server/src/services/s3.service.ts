import {
  S3Client,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  ListBucketsCommand,
  CreateBucketCommand,
  PutObjectCommand,
  type BucketLocationConstraint
} from "@aws-sdk/client-s3"
import type { readEnv } from "../config/env.js"
import type { Readable } from "node:stream"

export function createS3Service(config: ReturnType<typeof readEnv>) {
  // I use path-style addressing for Garage so bucket names do not require DNS records.
  // I keep SDK calls here: controllers handle HTTP, while this service only handles S3.
  const options = {
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true
  }
  const client = new S3Client(options)
  // I never replay a write after an ambiguous network outcome or replay a consumed stream.
  const creationClient = new S3Client({
    ...options,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED"
  })
  const listBuckets = async () => {
    const result = await client.send(new ListBucketsCommand({}))
    return (result.Buckets ?? []).map(bucket => ({
      name: bucket.Name!,
      createdAt: bucket.CreationDate
    }))
  }
  return {
    async createFolder(bucket: string, key: string) {
      const result = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: key, EncodingType: "url", MaxKeys: 1 })
      )
      if (result.Contents?.length)
        throw Object.assign(new Error("Folder already exists"), { name: "FolderAlreadyExists" })
      await creationClient.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: Buffer.alloc(0),
          ContentLength: 0,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*"
        })
      )
      return { key, prefix: key }
    },
    async checkUpload(bucket: string, key: string, overwrite: boolean, signal: AbortSignal) {
      // I always check the exact key. This is advisory: Garage ignores conditional PUT.
      let exists = false
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
          abortSignal: signal
        })
        exists = true
      } catch (error) {
        if (!(error instanceof Error) || !["NoSuchKey", "NotFound"].includes(error.name))
          throw error
      }
      if (exists && !overwrite)
        throw Object.assign(new Error("The existing file will be overwritten"), {
          name: "ObjectAlreadyExists"
        })
    },
    async upload(
      bucket: string,
      key: string,
      size: number,
      body: Readable,
      overwrite: boolean,
      signal: AbortSignal
    ) {
      await creationClient.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: size,
          ContentType: "application/octet-stream",
          ...(!overwrite ? { IfNoneMatch: "*" } : {})
        }),
        { abortSignal: signal }
      )
      return { key, size }
    },
    async createBucket(name: string) {
      // I check exact visible names for friendly feedback, not as a reservation.
      if ((await listBuckets()).some(bucket => bucket.name === name))
        throw Object.assign(new Error("Bucket already exists"), { name: "BucketNameConflict" })
      try {
        await creationClient.send(
          new CreateBucketCommand({
            Bucket: name,
            ...(config.region === "us-east-1"
              ? {}
              : {
                  CreateBucketConfiguration: {
                    LocationConstraint: config.region as BucketLocationConstraint
                  }
                })
          })
        )
      } catch (error) {
        const code = error instanceof Error ? error.name : ""
        if (code === "BucketAlreadyExists" || code === "BucketAlreadyOwnedByYou")
          throw Object.assign(new Error("Bucket already exists"), { name: "BucketNameConflict" })
        if (code === "NotImplemented")
          throw Object.assign(new Error("Bucket creation is unsupported"), {
            name: "StorageOperationNotSupported"
          })
        if (
          ["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "NoSuchBucket"].includes(
            code
          )
        )
          throw error
        // I cannot infer that a failed response means the provider did not create the bucket.
        throw Object.assign(new Error("Bucket creation outcome is unknown"), {
          name: ["TimeoutError", "RequestTimeout"].includes(code)
            ? "BucketCreationTimedOut"
            : "BucketCreationOutcomeUnknown"
        })
      }
      return { name }
    },
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
    listBuckets
  }
}
export type S3Service = ReturnType<typeof createS3Service>

// I request URL-encoded listings so XML parsing cannot normalize key characters.
// I decode keys and prefixes exactly once, never continuation tokens or metadata.
function decodeKey(key: string, encoding?: string) {
  return encoding === "url" ? decodeURIComponent(key) : key
}
