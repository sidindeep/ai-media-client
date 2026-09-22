# Shared debug storage: Timeweb S3

## User intent and environment

- The current scope is the debug environment only. Localhost and the hosted debug service at `https://ai-media-client.bothost.tech/` must use the same PostgreSQL database and the same private object storage.
- No new VPS, release cluster, CDN, or custom storage domain is needed now. Production/release infrastructure is explicitly deferred until the release cluster is deployed.
- The hosted debug application runs in the Netherlands. The selected Timeweb bucket is in `ru-1` (Saint Petersburg). The public S3 API should be reachable cross-region; expect extra latency and review data-residency requirements before production. European object storage can be reconsidered for the release environment.

## Timeweb resource and credentials

- A private Timeweb S3 bucket named `ai-media-client` was created: bucket ID `564727`, Standard 100 GB preset `4623`, price 349 RUB/month.
- S3 endpoint: `https://s3.twcstorage.ru`; region: `ru-1`; path-style requests are enabled.
- The Timeweb management API token and S3 access credentials are stored only in the ignored local `.env`; values must never be copied into source, documentation, logs, summaries, or Git.
- Timeweb management API responses obtained through an API key mask the S3 secret as `hidden-by-api-key-policy`. The real S3 Secret Access Key was supplied separately by the user and is now configured locally.
- Real S3 list, write, read, and cleanup operations succeeded with the configured credentials. The test object was removed.

## Architecture and behavior implemented

- Added an S3 storage adapter in `src/object-storage.js` using `@aws-sdk/client-s3`. Startup verifies bucket access with a bounded `ListObjectsV2` request.
- New media objects are tenant-scoped:
  - sources: `accounts/<account-id>/sources/<sha256>`;
  - saved generation results: `accounts/<account-id>/results/<request-id>/<index>.<ext>`;
  - Codex images: `accounts/<account-id>/codex-images/<request-id>.png`.
- PostgreSQL stores metadata and S3 object keys for new objects, not machine-local absolute paths. This lets localhost and the hosted debug instance read the same media.
- Existing local-file records remain supported as a compatibility fallback on the instance where those files exist.
- HTTP delivery supports private S3 objects through the authenticated application, including byte ranges for video and attachment downloads. The bucket remains private; no public bucket URL or storage subdomain is required.
- S3 credentials are injected only into the `media` container through the existing Compose `env_file`. The Codex sidecar does not receive them.
- Relevant implementation wiring was updated in `server.js`, `src/assets.js`, `src/server/config.js`, `src/server/http.js`, `src/services/accounts.js`, `src/services/media-service.js`, and `src/services/codex-billing.js`.
- Human documentation and the durable accounts/storage contract were updated in `.env.example`, `README.md`, `docs/accounts-and-credits.md`, `docs/codex.md`, and `tools/project-memory/specs/features/accounts-credits.md`.

## Configuration contract

Both localhost and the hosted debug service require the same S3 variables:

```env
MEDIA_STORAGE_DRIVER=s3
MEDIA_S3_ENDPOINT=https://s3.twcstorage.ru
MEDIA_S3_BUCKET=ai-media-client
MEDIA_S3_REGION=ru-1
MEDIA_S3_ACCESS_KEY=<private>
MEDIA_S3_SECRET_KEY=<private>
MEDIA_S3_FORCE_PATH_STYLE=true
```

- Local `.env` is already configured and ignored by Git.
- The user will add these variables to Bothost. The current task did not modify the Bothost environment or deploy the new code there.

## Verification evidence

- `pnpm check` passed.
- The targeted S3, assets, HTTP/config, and Codex test set passed: 28 tests, 0 failures.
- `docker compose up -d --build` rebuilt the current Compose project with `@aws-sdk/client-s3` installed in the media image.
- `docker compose ps` reported both `media` and `codex` healthy.
- `http://127.0.0.1:3000/api/health` returned `ok: true`; shared PostgreSQL was connected and generation was configured.
- S3 connectivity was also verified from inside the running `media` container.
- A full `pnpm test` run had one unrelated failure in `test/credit-display.test.js`: Node could not resolve `../i18n` from a `data:` URL. That test and the affected UI module were not changed by the S3 work.
- A tracked-files scan confirmed that neither the S3 access key nor secret key appears in Git-tracked changes.

## Current repository state and next useful step

- The S3 implementation, tests, documentation, dependency manifest, and lockfile are uncommitted working-tree changes. Preserve them and do not discard unrelated work.
- Next: add the listed variables to Bothost, deploy the current code there, and verify `https://ai-media-client.bothost.tech/api/health` plus an authenticated upload/read from that host. This is the definitive connectivity check from the Netherlands.
- Do not add a storage domain, public bucket policy, CDN, VPS, or release-cluster infrastructure unless the user explicitly expands scope.
