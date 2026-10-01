# Portable logger source

Copied from `../ai_logger/clients/node/` on 2026-09-30. These files belong to
this runtime; the source repository is never read during build or execution.
`client.mjs` and `sanitize.mjs` follow the portable source. `system-errors.mjs`
adds `onRecord` (independent metadata mirroring) and `maxDrainMs` (bounded HTTP
shutdown). The SQL and private PostgreSQL sink are retained for source parity
and portable tests; the application does not call them or connect to logger DB.
Product adapter: `index.js`; central-only compatibility adapter: `../system-errors.js`.
HTTP message remains an event identifier. The updated exception and diagnostic
allowlists preserve sanitized Error text and its original stack; arbitrary details
remain excluded. diagnostics.js supplies the shared sanitizer and derives real
V8 locations. Product-specific sanitizer additions remove labeled private fields,
embedded JSON payloads and URL credentials. identity.js resolves the canonical
product project and actual hostname:PID automatically for every replica; legacy
AI_LOGGER_PROJECT and AI_LOGGER_INSTANCE_ID environment values are ignored.

2026-10-01 owner-authorized product extension: generation-context.mjs selects
error-only prompt/source_urls/provider/model/job_id/request_id through a
separate generation envelope. Ordinary details remain excluded. sanitizer.prompt
retains prompt prose/JSON while removing secrets and inline image bytes; the
normal sanitizer still rejects prompt fields. Content URLs keep existing account
authorization; no public S3 or signed URL is introduced. The logger reader is
currently public, so logged prompt text is visible there.
