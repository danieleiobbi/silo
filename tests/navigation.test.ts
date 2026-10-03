import assert from "node:assert/strict"
import test from "node:test"
import { bucketUrl } from "../apps/web/src/lib/location.ts"

test("prefix URL preserves S3 characters and dot segments", () => {
  for (const prefix of ["../", "a/./b/", "a//b/", "é/汉字/#?%+ /", "a/%2F/", "/"]) {
    const url = new URL(bucketUrl("test-bucket", prefix), "http://localhost")
    assert.equal(url.searchParams.get("prefix"), prefix)
    assert.equal(url.pathname, "/buckets/test-bucket")
  }
})
