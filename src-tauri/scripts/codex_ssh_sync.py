#!/usr/bin/env python3
"""Apply a staged CPS Codex projection and repair remote session state atomically."""

import datetime
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import sys
from pathlib import Path


OUTPUT_PREFIX = "__CPS_CODEX_SYNC_TRANSACTION__"
BUNDLE_FILES = {"auth.json", "config.toml", ".cockpit_codex_auth.json"}


def empty_result():
    return {
        "success": False,
        "error_stage": None,
        "error": None,
        "database_found": False,
        "backup_path": None,
        "provider_schema_supported": False,
        "visibility_schema_supported": False,
        "rollout_schema_supported": False,
        "provider_rows_to_repair": 0,
        "visibility_rows_to_repair": 0,
        "rollout_files_to_repair": 0,
        "rows_repaired": 0,
        "rollout_files_repaired": 0,
        "provider_rows_remaining": 0,
        "visibility_rows_remaining": 0,
        "rollout_files_remaining": 0,
        "quick_check": None,
        "rollback_performed": False,
        "rollback_verified": False,
        "orphan_rollouts_found": 0,
        "rollout_paths_repaired": 0,
        "user_events_recovered": 0,
        "cwd_rows_repaired": 0,
    }


def sha256_bytes(content):
    return hashlib.sha256(content).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def quick_check(connection):
    return "; ".join(str(row[0]) for row in connection.execute("PRAGMA quick_check"))


def is_inside(path, parent):
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def fsync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path, content, mode, times_ns=None):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.parent / ("." + path.name + ".cps-sync-" + str(os.getpid()) + ".tmp")
    try:
        with temporary.open("xb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        if times_ns is not None:
            os.utime(temporary, ns=times_ns, follow_symlinks=False)
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def write_json(path, value):
    atomic_write(
        path,
        (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n").encode("utf-8"),
        0o600,
    )


def file_metadata(path):
    metadata = path.stat()
    return {
        "sha256": sha256_file(path),
        "mode": stat.S_IMODE(metadata.st_mode),
        "atime_ns": metadata.st_atime_ns,
        "mtime_ns": metadata.st_mtime_ns,
        "size": metadata.st_size,
    }


def fingerprint(path):
    metadata = path.stat()
    return (metadata.st_size, metadata.st_mtime_ns, sha256_file(path))


def resolve_managed_path(root, raw_path):
    path = Path(str(raw_path))
    if not path.is_absolute():
        path = root / path
    resolved = path.resolve()
    return resolved if is_inside(resolved, root) else None


def load_staged_bundle(root, staging):
    staging_root = (root / ".cps-codex-sync" / "staging").resolve()
    staging = staging.resolve()
    if not is_inside(staging, staging_root) or staging.parent != staging_root:
        raise RuntimeError("staging directory is outside the managed staging root")
    manifest_path = staging / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise RuntimeError("staging manifest is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = manifest.get("files")
    if not isinstance(files, list) or {item.get("relative_path") for item in files} != BUNDLE_FILES:
        raise RuntimeError("staging manifest does not contain the complete projection bundle")
    staged = []
    for item in files:
        relative_path = item.get("relative_path")
        expected_hash = item.get("sha256")
        mode = item.get("mode")
        path = staging / relative_path
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("invalid staged projection file: " + str(relative_path))
        content = path.read_bytes()
        if sha256_bytes(content) != expected_hash:
            raise RuntimeError("staged projection hash mismatch: " + str(relative_path))
        if not isinstance(mode, int) or mode < 0 or mode > 0o777:
            raise RuntimeError("invalid staged projection mode: " + str(relative_path))
        staged.append((relative_path, path, content, mode, expected_hash))
    return manifest, staged


def scan_rollout_paths(root, referenced_paths):
    paths = set()
    for directory in (root / "sessions", root / "archived_sessions"):
        if directory.is_dir():
            paths.update(path.resolve() for path in directory.rglob("rollout-*.jsonl") if path.is_file())
    for raw_path in referenced_paths:
        path = resolve_managed_path(root, raw_path)
        if path is not None and path.is_file():
            paths.add(path)
    return sorted(paths, key=str)


def parse_rollout(path, model_provider):
    content = path.read_bytes()
    has_user_event = b'"user_message"' in content or b'"user_input"' in content
    lines = content.splitlines(keepends=True)
    session_id = None
    cwd = None
    provider = None
    updated = None
    for index, raw_line in enumerate(lines):
        body = raw_line.rstrip(b"\r\n")
        ending = raw_line[len(body):]
        try:
            record = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not isinstance(record, dict) or record.get("type") != "session_meta":
            continue
        payload = record.get("payload")
        if not isinstance(payload, dict):
            continue
        raw_id = payload.get("id", payload.get("session_id"))
        if isinstance(raw_id, str) and raw_id.strip():
            session_id = raw_id.strip()
        raw_cwd = payload.get("cwd")
        if isinstance(raw_cwd, str) and raw_cwd.strip():
            cwd = raw_cwd.strip()
        provider = payload.get("model_provider")
        if provider != model_provider:
            payload["model_provider"] = model_provider
            lines[index] = json.dumps(
                record, separators=(",", ":"), ensure_ascii=False
            ).encode("utf-8") + ending
            updated = b"".join(lines)
        break
    metadata = path.stat()
    return {
        "path": path,
        "session_id": session_id,
        "cwd": cwd,
        "has_user_event": has_user_event,
        "provider": provider,
        "updated": updated,
        "fingerprint": (metadata.st_size, metadata.st_mtime_ns, sha256_bytes(content)),
        "mtime_ns": metadata.st_mtime_ns,
    }


def choose_rollout(facts, archived):
    preferred = "archived_sessions" if archived else "sessions"
    return max(
        facts,
        key=lambda fact: (
            preferred in fact["path"].parts,
            fact["mtime_ns"],
            str(fact["path"]),
        ),
    )


def plan_database(connection, root, model_provider):
    columns = [str(row[1]) for row in connection.execute("PRAGMA table_info(threads)")]
    column_set = set(columns)
    provider_supported = "model_provider" in column_set
    visibility_supported = "has_user_event" in column_set
    rollout_supported = "rollout_path" in column_set
    if not provider_supported or not visibility_supported:
        raise RuntimeError(
            "unsupported threads schema: model_provider={}, visibility={}".format(
                provider_supported, visibility_supported
            )
        )

    selected_columns = ["id", "model_provider", "has_user_event"]
    for optional in ("rollout_path", "cwd", "thread_source", "archived"):
        if optional in column_set:
            selected_columns.append(optional)
    rows = [dict(zip(selected_columns, row)) for row in connection.execute(
        "SELECT " + ", ".join(selected_columns) + " FROM threads"
    )]
    referenced = [row.get("rollout_path") for row in rows if row.get("rollout_path")]
    rollout_facts = [parse_rollout(path, model_provider) for path in scan_rollout_paths(root, referenced)]
    facts_by_id = {}
    for fact in rollout_facts:
        if fact["session_id"]:
            facts_by_id.setdefault(fact["session_id"], []).append(fact)

    row_ids = {str(row["id"]) for row in rows}
    orphan_ids = {session_id for session_id in facts_by_id if session_id not in row_ids}
    updates = []
    provider_rows = 0
    visible_rows = 0
    path_rows = 0
    user_rows = 0
    cwd_rows = 0
    for row in rows:
        session_id = str(row["id"])
        assignments = {}
        if (row.get("model_provider") or "") != model_provider:
            provider_rows += 1
            assignments["model_provider"] = model_provider
        facts = facts_by_id.get(session_id, [])
        fact = choose_rollout(facts, bool(row.get("archived", 0))) if facts else None
        if fact and fact["has_user_event"] and int(row.get("has_user_event") or 0) != 1:
            visible_rows += 1
            user_rows += 1
            assignments["has_user_event"] = 1
            if "thread_source" in column_set and not (row.get("thread_source") or "").strip():
                assignments["thread_source"] = "user"
        if fact and rollout_supported:
            current = resolve_managed_path(root, row.get("rollout_path")) if row.get("rollout_path") else None
            if current != fact["path"] or not fact["path"].is_file():
                path_rows += 1
                assignments["rollout_path"] = str(fact["path"])
        if fact and "cwd" in column_set and fact["cwd"] and not (row.get("cwd") or "").strip():
            cwd_rows += 1
            assignments["cwd"] = fact["cwd"]
        if assignments:
            updates.append((session_id, assignments))

    rollout_changes = [fact for fact in rollout_facts if fact["updated"] is not None]
    return {
        "columns": column_set,
        "rows": rows,
        "updates": updates,
        "rollouts": rollout_facts,
        "rollout_changes": rollout_changes,
        "provider_rows": provider_rows,
        "visibility_rows": visible_rows,
        "path_rows": path_rows,
        "user_rows": user_rows,
        "cwd_rows": cwd_rows,
        "orphan_rows": len(orphan_ids),
        "provider_supported": provider_supported,
        "visibility_supported": visibility_supported,
        "rollout_supported": rollout_supported,
    }


def verify_rollout_fingerprints(plan):
    return all(
        fact["path"].is_file() and fingerprint(fact["path"]) == fact["fingerprint"]
        for fact in plan["rollout_changes"]
    )


def backup_state(root, staged, db_path, connection, plan):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    backup_dir = root / ("recovery-backup-" + stamp + "-cps-sync")
    backup_dir.mkdir(mode=0o700, parents=False, exist_ok=False)
    manifest = {"version": 1, "created_at": stamp, "files": [], "operations": []}

    for relative_path, _, _, mode, expected_hash in staged:
        live_path = root / relative_path
        record = {
            "kind": "bundle",
            "relative_path": relative_path,
            "existed": live_path.exists(),
            "planned_sha256": expected_hash,
            "planned_mode": mode,
        }
        if live_path.exists():
            if live_path.is_symlink() or not live_path.is_file():
                raise RuntimeError("live projection target is not a regular file: " + relative_path)
            destination = backup_dir / "bundle" / relative_path
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            shutil.copy2(live_path, destination)
            record.update(file_metadata(destination))
        manifest["files"].append(record)
        manifest["operations"].append({"kind": "replace_bundle", "path": relative_path})

    if connection is not None:
        backup_db = backup_dir / "state_5.sqlite"
        live_db_metadata = db_path.stat()
        backup_connection = sqlite3.connect(str(backup_db))
        try:
            connection.backup(backup_connection)
        finally:
            backup_connection.close()
        os.chmod(backup_db, 0o600)
        db_metadata = file_metadata(backup_db)
        db_metadata.update({
            "mode": stat.S_IMODE(live_db_metadata.st_mode),
            "atime_ns": live_db_metadata.st_atime_ns,
            "mtime_ns": live_db_metadata.st_mtime_ns,
        })
        db_metadata.update({"kind": "sqlite", "relative_path": "state_5.sqlite", "existed": True})
        manifest["files"].append(db_metadata)
        manifest["operations"].append({"kind": "update_sqlite", "path": "state_5.sqlite"})

    for fact in plan["rollout_changes"] if plan else []:
        relative_path = str(fact["path"].relative_to(root))
        destination = backup_dir / "rollouts" / relative_path
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copy2(fact["path"], destination)
        record = file_metadata(destination)
        record.update({"kind": "rollout", "relative_path": relative_path, "existed": True})
        manifest["files"].append(record)
        manifest["operations"].append({"kind": "replace_rollout", "path": relative_path})

    write_json(backup_dir / "manifest.json", manifest)
    return backup_dir, manifest


def restore_backup(root, backup_dir, manifest):
    errors = []
    sqlite_record = next((item for item in manifest["files"] if item["kind"] == "sqlite"), None)
    for record in reversed(manifest["files"]):
        kind = record["kind"]
        if kind == "sqlite":
            continue
        target = root / record["relative_path"]
        try:
            if not record["existed"]:
                if target.exists() or target.is_symlink():
                    target.unlink()
                continue
            source_root = "bundle" if kind == "bundle" else "rollouts"
            source = backup_dir / source_root / record["relative_path"]
            atomic_write(
                target,
                source.read_bytes(),
                int(record["mode"]),
                (int(record["atime_ns"]), int(record["mtime_ns"])),
            )
        except Exception as error:
            errors.append(kind + ":" + record["relative_path"] + ":" + str(error))

    if sqlite_record is not None:
        try:
            for suffix in ("-wal", "-shm"):
                sidecar = Path(str(root / "state_5.sqlite") + suffix)
                if sidecar.exists():
                    sidecar.unlink()
            atomic_write(
                root / "state_5.sqlite",
                (backup_dir / "state_5.sqlite").read_bytes(),
                int(sqlite_record["mode"]),
                (int(sqlite_record["atime_ns"]), int(sqlite_record["mtime_ns"])),
            )
        except Exception as error:
            errors.append("sqlite:state_5.sqlite:" + str(error))

    if errors:
        raise RuntimeError("; ".join(errors))
    for record in manifest["files"]:
        target = root / record["relative_path"]
        if not record["existed"]:
            if target.exists() or target.is_symlink():
                raise RuntimeError("rollback left newly created file: " + str(target))
        elif sha256_file(target) != record["sha256"]:
            raise RuntimeError("rollback hash mismatch: " + str(target))


def apply_database_updates(connection, plan, model_provider, root):
    connection.execute("BEGIN IMMEDIATE")
    try:
        for session_id, assignments in plan["updates"]:
            columns = list(assignments)
            parameters = [assignments[column] for column in columns] + [session_id]
            connection.execute(
                "UPDATE threads SET " + ", ".join(column + " = ?" for column in columns) + " WHERE id = ?",
                parameters,
            )
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise

    provider_remaining = connection.execute(
        "SELECT COUNT(*) FROM threads WHERE COALESCE(model_provider, '') <> ?", (model_provider,)
    ).fetchone()[0]
    visibility_remaining = 0
    for fact in plan["rollouts"]:
        if fact["session_id"] and fact["has_user_event"]:
            row = connection.execute(
                "SELECT has_user_event FROM threads WHERE id = ?", (fact["session_id"],)
            ).fetchone()
            if row is not None and int(row[0] or 0) != 1:
                visibility_remaining += 1
    path_remaining = 0
    if plan["rollout_supported"]:
        for fact in plan["rollouts"]:
            if not fact["session_id"]:
                continue
            row = connection.execute(
                "SELECT rollout_path FROM threads WHERE id = ?", (fact["session_id"],)
            ).fetchone()
            if row is None:
                continue
            resolved = resolve_managed_path(root, row[0]) if row[0] else None
            if resolved is None or not resolved.is_file():
                path_remaining += 1
    return provider_remaining, visibility_remaining, path_remaining, quick_check(connection)


def run(root, staging, model_provider, result):
    result["error_stage"] = "validate_staging"
    manifest, staged = load_staged_bundle(root, staging)
    if not model_provider.strip():
        raise RuntimeError("model provider is empty")

    db_path = root / "state_5.sqlite"
    connection = None
    plan = None
    if db_path.exists():
        result["error_stage"] = "validate_database"
        if db_path.is_symlink() or not db_path.is_file():
            raise RuntimeError("state_5.sqlite is not a regular file")
        connection = sqlite3.connect(str(db_path), timeout=10.0, isolation_level=None)
        connection.execute("PRAGMA busy_timeout = 10000")
        initial_check = quick_check(connection)
        if initial_check != "ok":
            raise RuntimeError("state_5.sqlite quick_check failed before sync: " + initial_check)
        result["database_found"] = True

        result["error_stage"] = "plan_reconciliation"
        test_mutation = os.environ.get("CPS_SSH_SYNC_TEST_MUTATE_ROLLOUT", "")
        for attempt in range(2):
            plan = plan_database(connection, root, model_provider)
            if test_mutation and plan["rollout_changes"]:
                if test_mutation == "always" or attempt == 0:
                    with plan["rollout_changes"][0]["path"].open("ab") as output:
                        output.write(b"\n")
            if verify_rollout_fingerprints(plan):
                break
            if attempt == 1:
                raise RuntimeError("rollout changed during planning twice")
        result.update({
            "provider_schema_supported": plan["provider_supported"],
            "visibility_schema_supported": plan["visibility_supported"],
            "rollout_schema_supported": plan["rollout_supported"],
            "provider_rows_to_repair": plan["provider_rows"],
            "visibility_rows_to_repair": plan["visibility_rows"],
            "rollout_files_to_repair": len(plan["rollout_changes"]),
            "orphan_rollouts_found": plan["orphan_rows"],
            "rollout_paths_repaired": plan["path_rows"],
            "user_events_recovered": plan["user_rows"],
            "cwd_rows_repaired": plan["cwd_rows"],
        })

    result["error_stage"] = "create_backup"
    backup_dir, backup_manifest = backup_state(root, staged, db_path, connection, plan)
    result["backup_path"] = str(backup_dir)
    mutation_started = False
    try:
        result["error_stage"] = "apply_bundle"
        mutation_started = True
        for relative_path, _, content, mode, _ in staged:
            atomic_write(root / relative_path, content, mode)
            if os.environ.get("CPS_SSH_SYNC_TEST_FAIL_STAGE") == "bundle" and relative_path == "auth.json":
                raise RuntimeError("injected bundle failure")

        result["error_stage"] = "apply_rollouts"
        if plan and not verify_rollout_fingerprints(plan):
            raise RuntimeError("rollout changed after planning")
        for fact in plan["rollout_changes"] if plan else []:
            metadata = fact["path"].stat()
            atomic_write(
                fact["path"],
                fact["updated"],
                stat.S_IMODE(metadata.st_mode),
                (metadata.st_atime_ns, metadata.st_mtime_ns),
            )
        result["rollout_files_repaired"] = len(plan["rollout_changes"]) if plan else 0
        if os.environ.get("CPS_SSH_SYNC_TEST_FAIL_STAGE") == "rollout":
            raise RuntimeError("injected rollout failure")

        result["error_stage"] = "apply_database"
        if connection is not None:
            provider_remaining, visibility_remaining, path_remaining, final_check = apply_database_updates(
                connection, plan, model_provider, root
            )
            result.update({
                "rows_repaired": len(plan["updates"]),
                "provider_rows_remaining": provider_remaining,
                "visibility_rows_remaining": visibility_remaining,
                "quick_check": final_check,
            })
            if os.environ.get("CPS_SSH_SYNC_TEST_FAIL_STAGE") == "database":
                raise RuntimeError("injected database failure")
            if provider_remaining or visibility_remaining or path_remaining or final_check != "ok":
                raise RuntimeError(
                    "database verification failed: provider={}, visibility={}, path={}, quick_check={}".format(
                        provider_remaining, visibility_remaining, path_remaining, final_check
                    )
                )

        result["error_stage"] = "verify"
        rollout_remaining = 0
        for fact in plan["rollout_changes"] if plan else []:
            checked = parse_rollout(fact["path"], model_provider)
            if checked["provider"] != model_provider:
                rollout_remaining += 1
        result["rollout_files_remaining"] = rollout_remaining
        if rollout_remaining:
            raise RuntimeError("rollout verification failed: remaining=" + str(rollout_remaining))
        for relative_path, _, _, mode, expected_hash in staged:
            live_path = root / relative_path
            if sha256_file(live_path) != expected_hash or stat.S_IMODE(live_path.stat().st_mode) != mode:
                raise RuntimeError("projection verification failed: " + relative_path)
        result["success"] = True
        result["error_stage"] = None
        result["error"] = None
        return
    except Exception as original_error:
        if connection is not None:
            try:
                connection.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            connection.close()
            connection = None
        if mutation_started:
            result["rollback_performed"] = True
            try:
                restore_backup(root, backup_dir, backup_manifest)
                result["rollback_verified"] = True
                result["rollout_files_repaired"] = 0
            except Exception as rollback_error:
                raise RuntimeError(str(original_error) + "; rollback failed: " + str(rollback_error))
        raise
    finally:
        if connection is not None:
            connection.close()


def main():
    result = empty_result()
    stage = "arguments"
    staging = None
    try:
        if len(sys.argv) != 4:
            raise RuntimeError("expected codex home, staging directory, and model provider")
        root = Path(sys.argv[1]).expanduser().resolve()
        staging = Path(sys.argv[2]).expanduser().resolve()
        model_provider = sys.argv[3]
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        run(root, staging, model_provider, result)
    except Exception as error:
        result["success"] = False
        result["error_stage"] = result.get("error_stage") or stage
        result["error"] = str(error)
    finally:
        if staging is not None:
            staging_root = (Path(sys.argv[1]).expanduser().resolve() / ".cps-codex-sync" / "staging").resolve()
            if staging.parent == staging_root and staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
        print(OUTPUT_PREFIX + json.dumps(result, separators=(",", ":"), ensure_ascii=True))


if __name__ == "__main__":
    main()
