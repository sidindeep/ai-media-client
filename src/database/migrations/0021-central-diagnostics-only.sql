-- Explicit owner request: retire all application-owned technical error rows.
-- Product generation journals and task-owned errors are not diagnostics.
DROP TABLE IF EXISTS media_system_errors;
