import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let root: string;
let readFolderFile: typeof import('../src/lib/storage')['readFolderFile'];

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'jobpilot-storage-'));
  process.env.STORAGE_ROOT = root;
  // Imported after STORAGE_ROOT is set so the module reads the test root.
  ({ readFolderFile } = await import('../src/lib/storage'));

  const folder = path.join(root, 'user-1', 'applications/2026-08/acme-analyst');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'resume.txt'), 'ALEX MORGAN', 'utf8');

  // A secret belonging to a different user, and one outside the store entirely.
  await fs.mkdir(path.join(root, 'user-2'), { recursive: true });
  await fs.writeFile(path.join(root, 'user-2', 'private.txt'), 'OTHER USER SECRET', 'utf8');
  await fs.writeFile(path.join(root, 'outside.txt'), 'OUTSIDE THE STORE', 'utf8');
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('readFolderFile', () => {
  it('reads a file inside the applicant’s own folder', async () => {
    const content = await readFolderFile('user-1', 'applications/2026-08/acme-analyst', 'resume.txt');
    assert.equal(content, 'ALEX MORGAN');
  });

  it('returns null for a file that does not exist', async () => {
    const content = await readFolderFile('user-1', 'applications/2026-08/acme-analyst', 'nope.txt');
    assert.equal(content, null);
  });

  it('refuses to escape the folder with traversal sequences', async () => {
    const attempts = [
      '../../../outside.txt',
      '../../../../user-2/private.txt',
      '..%2f..%2foutside.txt',
      './../../outside.txt',
      '..',
      '.',
      '',
    ];
    for (const name of attempts) {
      const content = await readFolderFile('user-1', 'applications/2026-08/acme-analyst', name);
      assert.equal(content, null, `traversal succeeded for ${JSON.stringify(name)}`);
    }
  });

  it('does not read another applicant’s file through the relative path', async () => {
    const content = await readFolderFile('user-1', '../user-2', 'private.txt');
    assert.equal(content, null, 'crossed into another user’s storage');
  });

  it('refuses an absolute path', async () => {
    const content = await readFolderFile('user-1', 'applications/2026-08/acme-analyst', '/etc/hostname');
    assert.notEqual(content, await fs.readFile('/etc/hostname', 'utf8').catch(() => null));
  });
});
