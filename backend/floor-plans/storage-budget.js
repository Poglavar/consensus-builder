// Fail-closed archive and filesystem capacity checks. This module intentionally
// does not import blob-store.js so it can also guard requests before fetching.
import { lstat, readdir, stat, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const DEFAULT_MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;
export const DEFAULT_MIN_FREE_BYTES = 5 * 1024 ** 3;

export class ArchiveCapacityError extends Error {
  constructor(reason, details = {}) {
    super(`Floor-plan archive capacity check failed (${reason}).`);
    this.name = 'ArchiveCapacityError';
    this.code = 'ARCHIVE_CAPACITY';
    this.reason = reason;
    this.details = details;
  }
}

function positiveBytes(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new ArchiveCapacityError('storage-config', { variable: name, value: raw });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ArchiveCapacityError('storage-config', { variable: name, value: raw });
  }
  return value;
}

function monitoredPaths(env) {
  const raw = env.FLOOR_PLAN_STORAGE_PATHS;
  if (raw === undefined) return [];
  let values;
  try { values = JSON.parse(raw); }
  catch { throw new ArchiveCapacityError('storage-config', { variable: 'FLOOR_PLAN_STORAGE_PATHS' }); }
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim())) {
    throw new ArchiveCapacityError('storage-config', { variable: 'FLOOR_PLAN_STORAGE_PATHS' });
  }
  return values.map(value => resolve(value));
}

async function existingAncestor(path, fsImpl) {
  let current = resolve(path);
  while (true) {
    try { await fsImpl.stat(current); return current; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function physicalBytes(root, fsImpl) {
  let total = 0;
  let entries;
  try { entries = await fsImpl.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    const info = await fsImpl.lstat(path);
    if (info.isDirectory()) total += await physicalBytes(path, fsImpl);
    else total += Math.max(info.size, Number(info.blocks || 0) * 512);
  }
  return total;
}

export async function assertArchiveCapacity({
  additionalBytes = 0,
  root,
  checkArchiveBytes = true,
  env = process.env,
  fsImpl = { stat, lstat, readdir, statfs },
} = {}) {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) {
    throw new ArchiveCapacityError('storage-config', { additionalBytes });
  }
  const maxArchiveBytes = positiveBytes(env, 'FLOOR_PLAN_MAX_ARCHIVE_BYTES', DEFAULT_MAX_ARCHIVE_BYTES);
  const minFreeBytes = positiveBytes(env, 'FLOOR_PLAN_MIN_FREE_BYTES', DEFAULT_MIN_FREE_BYTES);
  const extraPaths = monitoredPaths(env);

  try {
    if (checkArchiveBytes) {
      if (!root) throw new Error('Archive root is required for physical-byte checks.');
      const archiveRoot = resolve(root);
      const bytes = await physicalBytes(archiveRoot, fsImpl);
      if (bytes + additionalBytes > maxArchiveBytes) {
        throw new ArchiveCapacityError('archive-limit', {
          root: archiveRoot, physicalBytes: bytes, additionalBytes, maxArchiveBytes,
        });
      }
    }

    const paths = [ ...(root ? [root] : []), ...extraPaths ];
    for (const path of paths) {
      const mountPath = await existingAncestor(path, fsImpl);
      const stats = await fsImpl.statfs(mountPath);
      const availableBytes = Number(stats.bavail) * Number(stats.bsize);
      if (!Number.isFinite(availableBytes) || availableBytes < minFreeBytes + additionalBytes) {
        throw new ArchiveCapacityError('free-space', {
          path: mountPath, availableBytes, minFreeBytes, additionalBytes,
        });
      }
    }
  } catch (error) {
    if (error instanceof ArchiveCapacityError) throw error;
    throw new ArchiveCapacityError('storage-unavailable', { message: error.message, code: error.code });
  }
  return true;
}
