# Legacy development compatibility source

The canonical library project is now the sibling `../../aixand-platform`.
New manifests, lockfiles, source snapshots, and builders use its version 0.1.0-beta.

This original compatibility copy is temporarily retained because existing editable
development environments, including Suite's worker environment, still point to
this directory. Keeping it preserves the code already used by running processes.
It is excluded from new release source snapshots.

Refresh those development environments from their updated dependency metadata
and restart their processes before removing this compatibility copy. Product
installer adoption and live environment migration remain separate operations.
