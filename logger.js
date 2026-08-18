const logs = [];
const MAX = 500;

function addLog({ module, status, message, meta = {} }) {
  const entry = { timestamp: new Date().toISOString(), module, status, message, ...meta };
  logs.unshift(entry);
  if (logs.length > MAX) logs.pop();
  console.log(JSON.stringify(entry));
}

function getLogs() { return logs; }

module.exports = { addLog, getLogs };
