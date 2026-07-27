const {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { createHash, randomBytes } = require("node:crypto");

// S3-compatible clients are cached per credential set so repeated uploads reuse
// the same keep-alive connection pool.
const clientCache = new Map();
function clientKey(config) {
  const credentialHash = createHash("sha256")
    .update(String(config.secretAccessKey || ""))
    .digest("hex");
  return [config.endpoint, config.region, config.accessKeyId, credentialHash].join("|");
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

async function uploadPart(
  client,
  bucket,
  key,
  uploadId,
  partNumber,
  body,
  length,
  abortSignal,
) {
  const result = await client.send(
    new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
      ContentLength: length,
    }),
    abortSignal ? { abortSignal } : undefined,
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

function probeError(error) {
  return String(
    error?.Code || error?.code || error?.name || error?.message || "请求失败",
  );
}

async function probeAccess(config, client = createClient(config)) {
  const token = randomBytes(16),
    key = `${String(config.prefix || "").replace(/^\/+|\/+$/g, "")}${config.prefix ? "/" : ""}.gpu-fleet-probe-${randomBytes(8).toString("hex")}`,
    result = {
      testedAt: new Date().toISOString(),
      connected: false,
      upload: false,
      download: false,
      uploadError: "",
      downloadError: "",
    };
  let uploaded = false;
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: token,
        ContentType: "application/octet-stream",
      }),
    );
    result.connected = true;
    result.upload = true;
    uploaded = true;
  } catch (error) {
    result.connected = Boolean(error?.$metadata?.httpStatusCode);
    result.uploadError = probeError(error);
  }
  try {
    const response = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      ),
      downloaded = Buffer.from(await response.Body.transformToByteArray());
    result.download = downloaded.equals(token);
    if (!result.download) result.downloadError = "下载内容校验失败";
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode,
      code = probeError(error);
    result.connected ||= Boolean(status);
    // A missing-key response proves GetObject authorization even when the
    // upload probe was denied and therefore no probe object exists.
    if (!uploaded && (status === 404 || code === "NoSuchKey")) {
      result.download = true;
    } else {
      result.downloadError = code;
    }
  } finally {
    if (uploaded) {
      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
        );
      } catch (error) {
        result.cleanupError = probeError(error);
      }
    }
  }
  return result;
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
  probeAccess,
  MIN_PART_BYTES,
};
