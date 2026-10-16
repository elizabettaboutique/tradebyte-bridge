'use strict';

const storage = require('./loggerPersistence');

if (typeof storage.persistLog !== 'function') {
  throw new Error(
    'loggerPersistence.js must export persistLog'
  );
}

const MAX_MEMORY_LOGS = 500;
const logs = [];

function getLogs() {
  return logs;
}

function addLog(module, status, message, metadata = {}) {
  // Support positional and object-style calls.
  if (
    module &&
    typeof module === 'object' &&
    !Array.isArray(module)
  ) {
    const input = module;

    module = input.module;
    status = input.status;
    message = input.message;
    metadata = input.metadata ?? input.meta ?? {};
  }

  const entry = {
    module: String(module || 'unknown'),
    status: String(status || 'info'),
    message: String(message || ''),
    metadata: metadata ?? {},
    timestamp: new Date().toISOString()
  };

  logs.push(entry);

  if (logs.length > MAX_MEMORY_LOGS) {
    logs.splice(0, logs.length - MAX_MEMORY_LOGS);
  }

  // Keep Railway output visible without printing metadata,
  // which may contain sensitive customer information.
  const consoleEntry = JSON.stringify({
    timestamp: entry.timestamp,
    module: entry.module,
    status: entry.status,
    message: entry.message
  });

  if (entry.status === 'error') {
    console.error(consoleEntry);
  } else {
    console.log(consoleEntry);
  }

  // Persistence must not block or crash the importer.
  Promise.resolve()
    .then(() => storage.persistLog(entry))
    .then(id => {
      if (!id) {
        throw new Error(
          'Persistence returned no confirmed log ID'
        );
      }
    })
    .catch(error => {
      console.error(
        '[tradebyte_logger] Persistence failed:',
        error instanceof Error
          ? error.message
          : String(error)
      );
    });

  return entry;
}

// No automatic deletion of historical logs.
module.exports = {
  logs,
  getLogs,
  addLog,
  pruneOldLogs: storage.pruneOldLogs
};
