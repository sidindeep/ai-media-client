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
