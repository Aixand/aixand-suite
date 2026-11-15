import { agentsRequestSchema } from './protocol.js';

describe('Local project files', () => {
  const id = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const valid = (op: string, args: object) => agentsRequestSchema.safeParse({ id, op, args }).success;
  it('accepts registered projects and bounded relative file paths', () => {
    expect(valid('project-files-list', { projectId })).toBe(true);
    expect(valid('project-files-list', { projectId, path: 'src/components', hidden: true, offset: 100, limit: 200 })).toBe(true);
    expect(valid('project-file-read', { projectId, path: '.aixand/project.json' })).toBe(true);
    expect(valid('project-file-read', { projectId, path: 'folder with spaces/こんにちは.txt' })).toBe(true);
  });
  it('rejects filesystem roots, traversal and caller-supplied directory overrides', () => {
    for (const path of ['', '/etc/passwd', '../outside', 'src/../outside', './file', 'src//file', 'src\\file', 'bad\0path'])
      expect(valid('project-file-read', { projectId, path })).toBe(false);
    for (const args of [{ projectId, root: '/tmp' }, { projectId, cwd: '/tmp' }, { projectId: 'project' },
      { projectId, offset: 5000 }, { projectId, offset: -1 }, { projectId, limit: 201 }, { projectId, hidden: 'true' }])
      expect(valid('project-files-list', args)).toBe(false);
    expect(valid('project-file-read', { projectId, path: 'file', write: true })).toBe(false);
  });
});
