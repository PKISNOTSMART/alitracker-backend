// Colored console logger
const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

function ts() {
  return new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const log = {
  info:    (msg) => console.log(`${c.blue}[${ts()}] ℹ  ${msg}${c.reset}`),
  success: (msg) => console.log(`${c.green}[${ts()}] ✓  ${msg}${c.reset}`),
  warn:    (msg) => console.log(`${c.yellow}[${ts()}] ⚠  ${msg}${c.reset}`),
  error:   (msg) => console.log(`${c.red}[${ts()}] ✗  ${msg}${c.reset}`),
  price:   (msg) => console.log(`${c.green}${c.bold}[${ts()}] 💰 ${msg}${c.reset}`),
  drop:    (msg) => console.log(`${c.green}${c.bold}[${ts()}] 🔻 ${msg}${c.reset}`),
  rise:    (msg) => console.log(`${c.yellow}[${ts()}] 🔺 ${msg}${c.reset}`),
  discord: (msg) => console.log(`${c.blue}[${ts()}] 🔔 ${msg}${c.reset}`),
  check:   (msg) => console.log(`${c.gray}[${ts()}]    ${msg}${c.reset}`),
  divider: ()    => console.log(`${c.gray}${'─'.repeat(52)}${c.reset}`),
};

module.exports = log;
