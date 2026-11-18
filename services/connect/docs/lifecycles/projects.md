# Project snapshots and remote workspaces

Snapshots copy current source bytes into a new remote workspace. They preserve neither Git history nor dependency/build trees. Snapshot preparation is independent of executing a test conversation: a prepared workspace proves publication, not test completion or a project-comparison report.

```mermaid
flowchart LR
  accTitle: Snapshot publication boundaries
  accDescr: Source selection produces a manifest-identified archive. Normal verified file transfer delivers it. Project preparation rechecks the archive, validates every entry, and publishes a new isolated directory. Remote conversation execution is a separate step whose Suite adapter is absent.
  Select[Select current source] --> Archive[ZIP and canonical manifest]
  Archive --> Transfer[Verified file transfer]
  Transfer --> Verify[Rehash archive and validate entries]
  Verify --> Stage[Private incoming directory]
  Stage --> Publish[Rename and prepared receipt]
  Publish -.-> Work[Separate remote conversation]
```

## Source selection and archive identity

| Concern | Contract in snapshot.py |
| --- | --- |
| Git project | `git -c core.fsmonitor=false -C ROOT ls-files -z --cached --others --exclude-standard -- .`; current modified/untracked bytes included, ignored/deleted files omitted |
| Non-Git directory | Walk without following links; built-in directory exclusions; no Git ignore interpretation |
| Built-in exclusions | VCS, dependency/cache/build trees, `aixand-snapshots`, credential names, `.env*` except example/sample/template, key/certificate suffixes and Connect-private paths |
| Custom excludes | `.aixand-connectignore`, at most 64 KiB; stripped non-comment lines, fnmatchcase or prefix matching; not full gitignore syntax |
| Unsafe input | Links, submodules, special files, duplicate paths, file/directory conflicts and NFC/casefold collisions rejected |
| Bounds | 1–10000 source files, 512 MiB total, at most 1024 bytes and 32 path components per relative portable path |
| Stability | Per-file descriptor stamps plus final selection/stat check reject edits during capture |
| Identity | Canonical version-1 `.aixand-snapshot.json` with path/size/hash/executable; `snapshotId` hashes manifest bytes; separate `sha256` hashes archive bytes |

The ignore list is a deterministic exclusion policy, not comprehensive secret detection. Review selected content when introducing new file types. Archive creation uses exclusive output and cleans up only its own newly created archive on failure.

## Preparation state and recovery

[ProjectWorkspaces.prepare](../../aixand_connect/project_workspace.py) requires exactly `transferId`, archive `sha256` and `snapshotId`, a completed matching transfer receipt and an archive no larger than 512 MiB plus 16 MiB overhead. It rehashes the delivered file before unpacking. `unpack` validates all entries before file creation, rejects encryption/links/unsafe paths, verifies manifest identity and each file checksum, and requires free space for source bytes plus 10 MiB.

| State | Durable meaning |
| --- | --- |
| missing | GET has no record; does not create a workspace |
| preparing | Archive validated for preparation; private incoming tree being constructed |
| publishing | Incoming tree verified; rename may have happened before final receipt |
| prepared | New workspace published; repeated same request returns existing record without resetting remote edits |
| failed | Preparation failed before target existed; incoming tree removed |

Publication uses the first configured project root at `aixand-snapshots/{operation UUID}`, staged as `.{UUID}.incoming`. Existing targets are never overwritten. Recovery from `publishing` recognizes a real target directory with a matching manifest hash and records prepared. It does not revalidate every current file against the original snapshot. New files receive private 0600/0700 modes, preserving executable intent rather than exact original permissions.

Read [snapshot.py](../../aixand_connect/snapshot.py), [project_workspace.py](../../aixand_connect/project_workspace.py) and [test_snapshot.py](../../tests/test_snapshot.py). The component has no project matrix scheduler, report synthesis or return-to-parent conversation implementation. Those historical Server orchestration paths are [explicit gaps](../reference/status.md).
