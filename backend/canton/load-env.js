// Loads backend/.env for the standalone Canton CLI scripts (dev-serve, check,
// check-route, seed). The full backend already loads it via index.js; these
// scripts run on their own, so import this FIRST. Uses an absolute path so it
// works regardless of the current working directory.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
