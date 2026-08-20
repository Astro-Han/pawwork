import { apply } from './zen-identity.mjs';

apply();

// Windows cannot deliver SIGTERM through ChildProcess.kill(). The owned IPC
// channel asks this Node process to enter DSH's existing graceful signal path.
process.on('message', (message) => {
  if (message !== 'SIGTERM') return;
  if (process.connected) process.disconnect();
  process.emit('SIGTERM');
});
