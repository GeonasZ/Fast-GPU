const test = require("node:test");
const assert = require("node:assert/strict");
const { probeAccess, uploadPart, listObjects, deleteObjects } = require("../lib/object-storage");

const config = {
  endpoint: "https://storage.example.test",
  region: "auto",
  bucket: "datasets",
  prefix: "project",
  accessKeyId: "key",
  secretAccessKey: "secret",
};

test("object storage probe verifies upload and download with a temporary object", async () => {
  const calls = [];
  const client = {
    async send(command) {
      const name = command.constructor.name;
      calls.push({ name, input: command.input });
      if (name === "GetObjectCommand") {
        const uploaded = calls.find((item) => item.name === "PutObjectCommand");
        return {
          Body: {
            transformToByteArray: async () => uploaded.input.Body,
          },
        };
      }
      return {};
    },
  };
  const result = await probeAccess(config, client);
  assert.equal(result.connected, true);
  assert.equal(result.upload, true);
  assert.equal(result.download, true);
  assert.deepEqual(
    calls.map((item) => item.name),
    ["PutObjectCommand", "GetObjectCommand", "DeleteObjectCommand"],
  );
  assert.match(calls[0].input.Key, /^project\/.fast-gpu-probe-/);
});

test("object storage probe checks download independently after upload denial", async () => {
  let calls = 0;
  const client = {
    async send(command) {
      calls += 1;
      if (command.constructor.name === "PutObjectCommand")
        throw Object.assign(new Error("Access denied"), {
          name: "AccessDenied",
          $metadata: { httpStatusCode: 403 },
        });
      throw Object.assign(new Error("Missing"), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      });
    },
  };
  const result = await probeAccess(config, client);
  assert.equal(result.connected, true);
  assert.equal(result.upload, false);
  assert.equal(result.download, true);
  assert.equal(result.uploadError, "AccessDenied");
  assert.equal(calls, 2);
});

test("multipart upload forwards the termination signal to the S3 client", async () => {
  const controller = new AbortController();
  let options;
  const client = {
    async send(_command, sendOptions) {
      options = sendOptions;
      return { ETag: "etag" };
    },
  };
  await uploadPart(
    client,
    "bucket",
    "key",
    "upload-id",
    1,
    Buffer.from("data"),
    4,
    controller.signal,
  );
  assert.equal(options.abortSignal, controller.signal);
});

test("object listing normalizes S3-compatible folders, objects, and pagination", async () => {
  let input;
  const client = {
    async send(command) {
      input = command.input;
      return {
        Contents: [{ Key: "project/model.bin", Size: 2048, LastModified: new Date("2026-07-27T10:00:00Z") }],
        CommonPrefixes: [{ Prefix: "project/data/" }],
        IsTruncated: true,
        NextContinuationToken: "next-page",
      };
    },
  };
  const result = await listObjects(client, "datasets", {
    prefix: "project/",
    continuationToken: "current-page",
    maxKeys: 1000,
  });
  assert.equal(input.MaxKeys, 500);
  assert.equal(input.Delimiter, "/");
  assert.equal(input.ContinuationToken, "current-page");
  assert.deepEqual(result.prefixes, ["project/data/"]);
  assert.equal(result.objects[0].size, 2048);
  assert.equal(result.nextContinuationToken, "next-page");
});

test("bulk object deletion deduplicates keys and reports partial failures", async () => {
  let input;
  const client = {
    async send(command) {
      input = command.input;
      return {
        Deleted: [{ Key: "one.bin" }],
        Errors: [{ Key: "two.bin", Code: "AccessDenied", Message: "denied" }],
      };
    },
  };
  const result = await deleteObjects(client, "datasets", ["one.bin", "one.bin", "two.bin"]);
  assert.deepEqual(input.Delete.Objects, [{ Key: "one.bin" }, { Key: "two.bin" }]);
  assert.deepEqual(result.deleted, ["one.bin"]);
  assert.equal(result.errors[0].code, "AccessDenied");
});

test("storage settings save does not require the primary provider to be enabled", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "server.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /主存储供应商必须处于启用状态/);
  assert.match(source, /objectStorage\.probeAccess/);
  assert.match(source, /storedStorageConfig\(\)\?\.verification/);
});

test("existing-instance S3 sync always shows and submits an explicit prefix", () => {
  const source = require("./frontend-source")(
    require("node:path").join(__dirname, ".."),
  );
  assert.match(source, /按需同步到实例/);
  assert.doesNotMatch(source, /Prefix（留空使用已保存值）/);
  assert.match(source, /prefix: \$\("#existingStoragePrefix"\)\.value,/);
  assert.match(source, /data-storage-box-prefix/);
  assert.match(source, /lastStorageBoxPrefix \|\| storageSelections\.at\(-1\)\?\.prefix \|\| ""/);
  assert.doesNotMatch(source, /keyPrefix:/);
  assert.match(source, /storagePathDialog/);
  assert.match(source, /data-storage-path-file/);
  assert.match(source, /fast-gpu-existing-storage-v1/);
  assert.match(source, /state\.prefix \|\| ""/);
  assert.match(source, /缺少时自动安装挂载工具/);
  assert.match(source, /autoInstall: \$\("#existingStorageAutoInstall"\)\.checked/);
});

test("new instances never auto-sync object storage", () => {
  const fs = require("node:fs"),
    path = require("node:path"),
    bootstrap = fs.readFileSync(path.join(__dirname, "..", "agent", "bootstrap.sh"), "utf8"),
    app = fs.readFileSync(path.join(__dirname, "..", "public", "storage-page.js"), "utf8");
  assert.doesNotMatch(bootstrap, /rclone sync --checksum/);
  assert.doesNotMatch(app, /新实例默认读取源/);
  assert.match(app, /新实例不会自动读取 S3/);
  assert.match(app, /Bucket 内目录或文件/);
});

test("saved storage verification survives closing and reopening the encrypted store", () => {
  const fs = require("node:fs"),
    os = require("node:os"),
    path = require("node:path"),
    { createProviderKeyStore } = require("../lib/provider-key-store"),
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-storage-test-")),
    env = {
      FLEET_DATABASE_PATH: path.join(directory, "fleet.sqlite"),
      FLEET_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 12).toString("base64"),
    },
    saved = {
      primaryProvider: "r2",
      providers: { r2: { enabled: false, bucket: "datasets" } },
      verification: {
        r2: {
          testedAt: "2026-07-27T12:00:00.000Z",
          connected: true,
          upload: true,
          download: true,
        },
      },
    };
  const first = createProviderKeyStore(env);
  try {
    first.set("__object_storage_config__", JSON.stringify(saved));
  } finally {
    first.close();
  }
  const reopened = createProviderKeyStore(env);
  try {
    const restored = JSON.parse(reopened.get("__object_storage_config__"));
    assert.deepEqual(restored.verification, saved.verification);
  } finally {
    reopened.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("interrupted local S3 uploads are persisted, reconciled, and explicitly removable", () => {
  const fs = require("node:fs"),
    path = require("node:path"),
    server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"),
    app = require("./frontend-source")(path.join(__dirname, "..")),
    preload = fs.readFileSync(
      path.join(__dirname, "..", "electron-preload.js"),
      "utf8",
    );
  assert.match(server, /STORAGE_UPLOAD_STATE_KEY/);
  assert.match(server, /persistActiveUploads\(\)/);
  assert.match(server, /fs\.existsSync\(record\.localPath\)/);
  assert.match(server, /storage_abort_failed/);
  assert.match(app, /loadStorageUploadQueue\(\)/);
  assert.match(app, /data-storage-resume/);
  assert.match(app, /data-storage-delete/);
  assert.match(app, /storageUploadTerminate/);
  assert.match(server, /activeUploadRuns/);
  assert.match(server, /\.abort\(\)/);
  assert.match(preload, /pickFiles/);
  assert.doesNotMatch(app, /重新选择同一文件继续/);
});

test("S3 upload selection supports files, folders, per-file choices, and compression groups", () => {
  const fs = require("node:fs"),
    path = require("node:path"),
    server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"),
    app = require("./frontend-source")(path.join(__dirname, "..")),
    preload = fs.readFileSync(path.join(__dirname, "..", "electron-preload.js"), "utf8"),
    client = fs.readFileSync(path.join(__dirname, "..", "local-client.js"), "utf8");
  assert.match(preload, /pickStorageFiles/);
  assert.match(preload, /pickStorageFolder/);
  assert.match(client, /multiSelections/);
  assert.match(client, /storageFiles/);
  assert.match(app, /data-storage-file-index/);
  assert.match(app, /data-storage-merge/);
  assert.match(app, /storage-compression-group/);
  assert.match(server, /\/api\/storage\/upload-groups/);
  assert.match(server, /generatedArchive/);
  assert.match(server, /application\/gzip/);
});

test("encrypted internal state supports a queue larger than the API-key limit", () => {
  const fs = require("node:fs"),
    os = require("node:os"),
    path = require("node:path"),
    { createProviderKeyStore } = require("../lib/provider-key-store"),
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-queue-test-")),
    env = {
      FLEET_DATABASE_PATH: path.join(directory, "fleet.sqlite"),
      FLEET_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"),
    },
    value = JSON.stringify({ uploads: "x".repeat(12000) }),
    store = createProviderKeyStore(env);
  try {
    store.set("__object_storage_uploads__", value);
    assert.equal(store.get("__object_storage_uploads__"), value);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
