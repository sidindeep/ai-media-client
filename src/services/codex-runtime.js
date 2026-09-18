function codexEnvironment(env = process.env) {
  // The hosting container also has database/OAuth/Kie secrets. Do not inherit them.
  return Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SystemRoot'].filter(key => env[key]).map(key => [key, env[key]]));
}
module.exports = { codexEnvironment };
