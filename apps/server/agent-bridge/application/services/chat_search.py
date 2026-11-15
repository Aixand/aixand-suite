"""Rebuildable, disk-backed chat search and bounded match navigation.

Provider history remains authoritative. This projection never initiates provider
reconciliation; callers ingest bounded journal/event pages and report coverage.
"""
import asyncio
import json
import re
import sqlite3
import time

BATCH_BYTES = 512 * 1024


class ChatSearch:
    def __init__(self, db, path):
        self.db, self.path = db, path
        self.task = None
        self.error = None
        with db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS chat_search_docs (
                    id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, item_id TEXT NOT NULL,
                    kind TEXT NOT NULL, text TEXT NOT NULL, record TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(chat_id,item_id));
                CREATE INDEX IF NOT EXISTS chat_search_order ON chat_search_docs(chat_id,ordinal,id);
                CREATE TABLE IF NOT EXISTS chat_search_streams (
                    chat_id TEXT NOT NULL, item_id TEXT NOT NULL, turn_id TEXT,
                    record TEXT NOT NULL, PRIMARY KEY(chat_id,item_id));
                CREATE TABLE IF NOT EXISTS chat_search_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE VIRTUAL TABLE IF NOT EXISTS chat_search_fts USING fts5(
                    text, content='chat_search_docs', content_rowid='id', prefix='2 3');
                CREATE TRIGGER IF NOT EXISTS chat_search_tombstone AFTER INSERT ON deleted_chats BEGIN
                    DELETE FROM chat_search_docs WHERE chat_id=new.id;
                    DELETE FROM chat_search_streams WHERE chat_id=new.id;
                    DELETE FROM chat_search_state WHERE key IN ('sdk:'||new.id,'pending:'||new.id,'error:'||new.id);
                END;
                CREATE TRIGGER IF NOT EXISTS chat_search_insert AFTER INSERT ON chat_search_docs BEGIN
                    INSERT INTO chat_search_fts(rowid,text) VALUES(new.id,new.text);
                END;
                CREATE TRIGGER IF NOT EXISTS chat_search_delete AFTER DELETE ON chat_search_docs BEGIN
                    INSERT INTO chat_search_fts(chat_search_fts,rowid,text) VALUES('delete',old.id,old.text);
                END;
                CREATE TRIGGER IF NOT EXISTS chat_search_update AFTER UPDATE OF text ON chat_search_docs BEGIN
                    INSERT INTO chat_search_fts(chat_search_fts,rowid,text) VALUES('delete',old.id,old.text);
                    INSERT INTO chat_search_fts(rowid,text) VALUES(new.id,new.text);
                END;
            ''')

    def state(self, key, default=''):
        row = self.db.execute('SELECT value FROM chat_search_state WHERE key=?', (key,)).fetchone()
        return row[0] if row else default

    def set_state(self, key, value):
        self.db.execute('INSERT INTO chat_search_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, str(value)))

    def metadata(self, record):
        if self.db.execute('SELECT 1 FROM deleted_chats WHERE id=?', (record['id'],)).fetchone():
            return
        summary = {key: record.get(key) for key in ('id', 'title', 'project', 'profile', 'provider', 'labels', 'updatedAt')}
        text = '\n'.join(str(record.get(key) or '') for key in ('title', 'project', 'profile', 'labels'))
        self.put(record['id'], '', 'metadata', text, summary)

    def put(self, chat_id, item_id, kind, text, record):
        self.db.execute('''INSERT INTO chat_search_docs(chat_id,item_id,kind,text,record,ordinal) VALUES (?,?,?,?,?,(SELECT COALESCE(MAX(ordinal),0)+1 FROM chat_search_docs WHERE chat_id=?))
            ON CONFLICT(chat_id,item_id) DO UPDATE SET kind=excluded.kind,text=excluded.text,record=excluded.record
            WHERE kind!=excluded.kind OR text!=excluded.text OR record!=excluded.record''',
            (chat_id, item_id, kind, text, json.dumps({key: value for key, value in record.items() if key != "text"}, ensure_ascii=False), chat_id))

    def retain(self, record, items, *, checkpoint=None, order_start=None, stream_done=(), turns_done=(), expected_cursor=None):
        with self.db:
            if self.db.execute('SELECT 1 FROM deleted_chats WHERE id=?', (record['id'],)).fetchone():
                return False
            if checkpoint and expected_cursor is not None:
                # Claim the cursor under SQLite's write lock so concurrent
                # bridge processes cannot append the same delta twice.
                self.db.execute('INSERT OR IGNORE INTO chat_search_state VALUES (?,?)', (checkpoint[0], str(expected_cursor)))
                if self.state(checkpoint[0]) != str(expected_cursor):
                    return False
            self.metadata(record)
            for offset, item in enumerate(items):
                text = item.get('text') or ''
                if not text and item.get('type') == 'userMessage':
                    text = '\n'.join(part.get('text', '') for part in item.get('content', []) if part.get('type') == 'text')
                text = str(text or item.get('aggregatedOutput') or '')
                if not text:
                    continue
                # The presentation contract already limits individual messages.
                projected = {key: item[key] for key in ('id', 'type', 'turnId', 'status', 'command', 'exitCode', 'source') if key in item}
                projected['text'] = text
                self.put(record['id'], item['id'], item.get('type', 'activity'), text, projected)
                if checkpoint:
                    self.db.execute('INSERT INTO chat_search_streams VALUES (?,?,?,?) ON CONFLICT(chat_id,item_id) DO UPDATE SET turn_id=excluded.turn_id,record=excluded.record',
                        (record['id'], item['id'], item.get('turnId'), json.dumps(projected, ensure_ascii=False)))
                if order_start is not None:
                    self.db.execute('UPDATE chat_search_docs SET ordinal=? WHERE chat_id=? AND item_id=?', (order_start + offset, record['id'], item['id']))
            if checkpoint:
                self.db.executemany('DELETE FROM chat_search_streams WHERE chat_id=? AND item_id=?', [(record['id'], key) for key in stream_done])
                self.db.executemany('DELETE FROM chat_search_streams WHERE chat_id=? AND turn_id=?', [(record['id'], key) for key in turns_done])
                self.set_state(*checkpoint)
        return True

    async def local_backfill(self):
        tables = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in ('suite_sdk_chats',):
            if table not in tables:
                continue
            key = 'local:' + table
            cursor = self.state(key)
            while True:
                rows = self.db.execute(f'SELECT id,record FROM {table} WHERE id>? ORDER BY id LIMIT 8', (cursor,)).fetchall()
                if not rows:
                    break
                for row in rows:
                    record = json.loads(row[1])
                    self.retain(record, record.get('items', []))
                    cursor = row[0]
                    with self.db:
                        self.set_state(key, cursor)
                    await asyncio.sleep(0)
        with self.db:
            self.set_state('local:done', '1')
            self.set_state('version', '1')
        self.error = None

    def start(self, extra=None):
        if self.task is None or self.task.done() and (self.error or self.state('local:done') != '1'):
            async def run():
                try:
                    await self.local_backfill()
                    if extra:
                        await extra()
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self.error = str(error)
            self.task = asyncio.create_task(run())

    async def close(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)

    async def search(self, args):
        result = await asyncio.to_thread(self._search, args)
        result['indexing'] = self.state('local:done') != '1' or bool(self.db.execute("SELECT 1 FROM chat_search_state WHERE key LIKE 'pending:%' AND value='1' LIMIT 1").fetchone())
        failure = self.db.execute("SELECT value FROM chat_search_state WHERE key LIKE 'error:%' LIMIT 1").fetchone()
        result['indexError'] = self.error or (failure[0] if failure else None)
        return result

    def _search(self, args):
        query = str(args.get('query', '')).strip()[:256]
        tokens = re.findall(r'"([^"\n]+)"|([^\W_]+)', query, re.UNICODE)[:16]
        terms = [phrase or word for phrase, word in tokens]
        if not terms:
            return dict(results=[], cursor=None, indexing=True, partial=True)
        expression = ' AND '.join('"' + term.replace('"', '""') + '"' + ('*' if index == len(terms)-1 and not query.endswith('"') else '') for index, term in enumerate(terms))
        limit = max(1, min(int(args.get('limit', 25)), 50))
        offset = max(0, min(int(args.get('cursor') or 0), 1000))
        db = sqlite3.connect(self.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=.2)
        db.row_factory = sqlite3.Row
        deadline = time.monotonic() + .25
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        try:
            db.execute('PRAGMA cache_size=-4096')
            filters = " AND d.chat_id NOT IN (SELECT id FROM deleted_chats)"
            if not args.get('includeTools'):
                filters += " AND d.kind IN ('metadata','userMessage','agentMessage','questionAnswer')"
            values = [expression]
            if args.get('project'):
                filters += " AND EXISTS (SELECT 1 FROM chat_search_docs m WHERE m.chat_id=d.chat_id AND m.item_id='' AND json_extract(m.record,'$.project')=?)"
                values.append(args['project'])
            # Bound ranked candidates before grouping; do not compute an exhaustive total.
            rows = db.execute('''SELECT d.chat_id,d.item_id,d.kind,
                snippet(chat_search_fts,0,char(1),char(2),' … ',28) excerpt,rank
                FROM chat_search_fts JOIN chat_search_docs d ON d.id=chat_search_fts.rowid
                WHERE chat_search_fts MATCH ?''' + filters + ' ORDER BY rank LIMIT 2000', values)
            best, candidates = {}, 0
            for row in rows:
                candidates += 1
                old = best.get(row['chat_id'])
                if old is None or row['kind'] == 'metadata' and old['kind'] != 'metadata':
                    best[row['chat_id']] = dict(row)
            ranked = sorted(best.values(), key=lambda row: (row['kind'] != 'metadata', row['rank'], row['chat_id']))
            results = []
            for row in ranked[offset:offset+limit]:
                metadata = db.execute("SELECT record FROM chat_search_docs WHERE chat_id=? AND item_id=''", (row['chat_id'],)).fetchone()
                if not metadata:
                    continue
                summary = json.loads(metadata[0])
                results.append(dict(chatId=row['chat_id'], itemId=row['item_id'] or None, title=summary.get('title') or 'Untitled chat',
                    project=summary.get('project'), profile=summary.get('profile'), excerpt=row['excerpt'][:400]))
            indexing = db.execute("SELECT value FROM chat_search_state WHERE key='local:done'").fetchone()
            return dict(results=results, cursor=str(offset+limit) if offset+limit < len(ranked) and offset+limit <= 1000 else None,
                indexing=not indexing, partial=True, bounded=candidates >= 2000)
        except sqlite3.OperationalError as error:
            if 'interrupted' in str(error):
                raise ValueError('This search is too broad. Add another word or choose a project.') from error
            raise
        finally:
            db.close()

    def page(self, chat_id, args):
        if self.db.execute('SELECT 1 FROM deleted_chats WHERE id=?', (chat_id,)).fetchone():
            raise ValueError('This conversation has been deleted')
        boundary = args.get('around') or args.get('before') or args.get('after')
        anchor = self.db.execute('SELECT ordinal,id FROM chat_search_docs WHERE chat_id=? AND item_id=?', (chat_id, boundary)).fetchone()
        if not anchor:
            raise ValueError('This history position is unavailable. Search again or return to latest.')
        def collect(comparison, order, count):
            rows = self.db.execute(f"SELECT record,text FROM chat_search_docs WHERE chat_id=? AND item_id!='' AND (ordinal,id){comparison}(?,?) ORDER BY ordinal {order},id {order} LIMIT ?", (chat_id, anchor[0], anchor[1], count))
            items, size = [], 0
            for row in rows:
                text = row[1][:49152].encode('utf-8')[:49152].decode('utf-8', errors='ignore')
                item = {**json.loads(row[0]), 'text': text}
                if text != row[1]:
                    item['truncated'] = True
                item_size = len(json.dumps(item, ensure_ascii=False).encode())
                if items and size + item_size > 128 * 1024:
                    break
                items.append(item)
                size += item_size
            return items
        if args.get('around'):
            items = list(reversed(collect('<', 'DESC', 8))) + collect('>=', 'ASC', 9)
        elif args.get('after'):
            items = collect('>', 'ASC', 40)
        else:
            items = list(reversed(collect('<', 'DESC', 40)))
        if not items:
            return dict(items=[], cursor=None, after=None, unavailable=True)
        ids = [self.db.execute('SELECT ordinal,id FROM chat_search_docs WHERE chat_id=? AND item_id=?', (chat_id, item['id'])).fetchone() for item in (items[0], items[-1])]
        older = self.db.execute("SELECT 1 FROM chat_search_docs WHERE chat_id=? AND item_id!='' AND (ordinal,id)<(?,?) LIMIT 1", (chat_id, ids[0][0], ids[0][1])).fetchone()
        newer = self.db.execute("SELECT 1 FROM chat_search_docs WHERE chat_id=? AND item_id!='' AND (ordinal,id)>(?,?) LIMIT 1", (chat_id, ids[1][0], ids[1][1])).fetchone()
        return dict(items=items, cursor=items[0]['id'] if older else None, after=items[-1]['id'] if newer else None, unavailable=True)
