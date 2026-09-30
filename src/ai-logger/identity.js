const { hostname } = require('node:os');

// Canonical product identity is independent of packaging and working directory.
function resolveIdentity() {
  return {
    project: 'ai-media-client',
    instanceId: `${hostname()}:${process.pid}`,
  };
}

module.exports = { resolveIdentity };
