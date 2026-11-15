"""Project stable native profile identities into local conversation metadata."""
import json
FIELDS = ("profile", "profileId", "homeId", "identityState", "profileDeleted", "connectionState")


def reconcile(state, manager):
    snapshot = manager.identity_snapshot()
    profiles = {row["id"]: row for row in snapshot["profiles"]}
    db = state.connect(True); changed = []
    try:
        with db:
            for raw, in db.execute("SELECT record FROM chats").fetchall():
                row = json.loads(raw)
                if row.get("deviceId") or row.get("provider", "codex") != manager.provider: continue
                before = json.dumps(row, sort_keys=True)
                profile = profiles.get(row.get("profileId"))
                if profile:
                    row.update(profile=profile["profile"], identityState="resolved", profileDeleted=False)
                elif row.get("profileId"):
                    row.update(identityState="needs_attention", profileDeleted=True)
                if json.dumps(row, sort_keys=True) != before:
                    row["revision"] = row.get("revision", 0) + 1
                    db.execute("UPDATE chats SET record=? WHERE id=?", (json.dumps(row), row["id"]))
                    changed.append(row)
    finally: db.close()
    return changed
