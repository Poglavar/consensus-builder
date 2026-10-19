import { startServer } from './index.js';

const server = startServer();
let shutdownPromise;

function shutdown(signal) {
    if (shutdownPromise) return shutdownPromise;

    console.log(`Received ${signal}; draining HTTP connections...`);
    shutdownPromise = server.gracefulShutdown()
        .then(() => {
            console.log('Graceful shutdown complete.');
            process.exitCode = 0;
        })
        .catch((error) => {
            console.error('Graceful shutdown failed:', error);
            process.exitCode = 1;
        });

    return shutdownPromise;
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
