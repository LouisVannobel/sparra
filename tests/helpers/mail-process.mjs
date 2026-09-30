// Windows child.kill does not deliver a cooperative POSIX signal. The fixture
// emits the same signal event inside its exclusively owned child process.
process.on('message', message => { if (message === 'shutdown') { process.emit('SIGTERM'); process.disconnect() } })
