const {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");

// S3-compatible clients are cached per credential set so repeated uploads reuse
// the same keep-alive connection pool.
const clientCache = new Map();
function clientKey(config) {
  return [config.endpoint, config.region, config.accessKeyId].join("|");
}
function createClient(config) {
  const key = clientKey(config);
  let client = clientCache.get(key);
  if (client) return client;
  client = new S3Client({
    region: config.region || "auto",
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // R2/OSS work with virtual-hosted style; keep the SDK default.
    forcePathStyle: false,
  });
  clientCache.set(key, client);
  return client;
}

// Each part but the last must be >= 5 MiB; keep the part count under the S3
// 10000-part ceiling. 8 MiB balances throughput and granularity for resume.
const MIN_PART_BYTES = 8 * 1024 * 1024;
function choosePartSize(fileSize) {
  if (!fileSize || fileSize <= MIN_PART_BYTES) return MIN_PART_BYTES;
  let partSize = MIN_PART_BYTES;
  while (Math.ceil(fileSize / partSize) > 9000) partSize *= 2;
  return partSize;
}

async function beginMultipart(client, bucket, key, contentType) {
  const result = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType || "application/octet-stream",
    }),
  );
  return result.UploadId;
}

async function uploadPart(client, bucket, key, uploadId, partNumber, body, length) {
  const result = await client.send(
    new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
      ContentLength: length,
    }),
  );
  return result.ETag;
}

async function listParts(client, bucket, key, uploadId) {
  const parts = [];
  let marker;
  do {
    const result = await client.send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: marker,
      }),
    );
    for (const part of result.Parts || [])
      parts.push({
        partNumber: part.PartNumber,
        etag: part.ETag,
        size: part.Size,
      });
    marker = result.IsTruncated ? result.NextPartNumberMarker : undefined;
  } while (marker);
  return parts;
}

async function completeMultipart(client, bucket, key, uploadId, parts) {
  const result = await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((part) => ({
          ETag: part.etag,
          PartNumber: part.partNumber,
        })),
      },
    }),
  );
  return result.Location || null;
}

async function abortMultipart(client, bucket, key, uploadId) {
  await client.send(
    new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
    }),
  );
}

// Single-shot path for files that fit in one part. Kept on the multipart
// primitives so the caller does not need a second code path.
async function putObject(client, bucket, key, body, contentType) {
  const result = await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    }),
  );
  return result.ETag;
}

module.exports = {
  createClient,
  choosePartSize,
  beginMultipart,
  uploadPart,
  listParts,
  completeMultipart,
  abortMultipart,
  putObject,
  MIN_PART_BYTES,
};
