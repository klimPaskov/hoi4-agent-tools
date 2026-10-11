import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type * as FileSystem from 'node:fs/promises';
import {
  TemporaryDirectoryLifetime,
  sweepTemporaryDirectories,
} from '../../src/hoi4_agent_tools/core/temporary-directories.js';

const lifetime = new TemporaryDirectoryLifetime();
let shared = new Set<string>();

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return {
    ...actual,
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const directory = await actual.mkdtemp(...args);
      // Test fixtures use string paths; retain Buffer overload behavior unchanged.
      if (typeof directory === 'string') await lifetime.own(directory);
      return directory;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const truncate = handle.truncate.bind(handle);
      handle.truncate = async (bytes = 0) => {
        lifetime.assertFileSize(String(args[0]), bytes);
        await truncate(bytes);
      };
      return handle;
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const data = args[1];
      const bytes =
        typeof data === 'string'
          ? Buffer.byteLength(
              data,
              typeof args[2] === 'string' ? args[2] : (args[2]?.encoding ?? 'utf8'),
            )
          : ArrayBuffer.isView(data)
            ? data.byteLength
            : undefined;
      const file = args[0];
      const filePath =
        typeof file === 'string'
          ? file
          : Buffer.isBuffer(file)
            ? file.toString()
            : file instanceof URL
              ? fileURLToPath(file)
              : undefined;
      if (bytes !== undefined && filePath !== undefined) lifetime.assertFileSize(filePath, bytes);
      await actual.writeFile(...args);
    },
  };
});

beforeAll(async () => {
  await sweepTemporaryDirectories(tmpdir());
});
beforeEach(() => {
  shared = new Set(lifetime.paths());
});
afterEach(async () => {
  for (const directory of lifetime.paths())
    if (!shared.has(directory)) await lifetime.release(directory);
});
afterAll(async () => {
  await lifetime.dispose();
});
