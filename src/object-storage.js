const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

function createObjectStorage(config, client) {
  if (!config?.enabled) return null;
  const s3 = client || new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
  });
  const request = command => s3.send(command);
  return {
    bucket: config.bucket,
    async check() { await request(new ListObjectsV2Command({ Bucket: config.bucket, MaxKeys: 1 })); },
    async put(key, body, contentType, size) {
      await request(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType, ...(Number.isInteger(size) ? { ContentLength: size } : {}) }));
      return key;
    },
    async read(key) {
      const result = await request(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      return Buffer.from(await result.Body.transformToByteArray());
    },
    async head(key) {
      const result = await request(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      return { size: Number(result.ContentLength || 0), type: result.ContentType || 'application/octet-stream' };
    },
    async stream(key, range) {
      const result = await request(new GetObjectCommand({ Bucket: config.bucket, Key: key, ...(range ? { Range: range } : {}) }));
      return {
        body: result.Body, size: Number(result.ContentLength || 0), type: result.ContentType || 'application/octet-stream',
        contentRange: result.ContentRange || '',
      };
    },
    async list(prefix = '') {
      const objects = []; let continuationToken;
      do {
        const result = await request(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ...(continuationToken ? { ContinuationToken: continuationToken } : {}) }));
        for (const item of result.Contents || []) objects.push({ key: item.Key, size: Number(item.Size || 0) });
        continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
      } while (continuationToken);
      return objects;
    },
  };
}

module.exports = { createObjectStorage };
