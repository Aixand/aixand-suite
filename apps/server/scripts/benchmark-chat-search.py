"""Disposable search benchmark: python3 apps/server/scripts/benchmark-chat-search.py.

Builds a temporary disk index from generated messages without retaining the corpus
in Python memory. Reports search latency, index size, and process peak RSS.
"""
import argparse
import asyncio
import importlib.util
import json
from pathlib import Path
import resource
import sqlite3
import statistics
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('benchmark_search', ROOT / 'apps/server/agent-bridge/application/services/chat_search.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def memory_mib():
    try:
        status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines())
        return {key: round(int(status[field].split()[0]) / 1024, 2) for key, field in [('rss_mib', 'VmRSS'), ('peak_rss_mib', 'VmHWM')]}
    except (OSError, KeyError):
        return {'peak_rss_mib': round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 2)}


async def main(chats, messages):
    with tempfile.TemporaryDirectory(prefix='suite-search-benchmark-') as folder:
        path = Path(folder) / 'search.sqlite3'
        db = sqlite3.connect(path)
        db.execute('CREATE TABLE deleted_chats(id TEXT PRIMARY KEY)')
        db.execute('PRAGMA cache_size=-4096')
        index = module.ChatSearch(db, path)
        start = time.perf_counter()
        initial_memory = memory_mib()
        for chat in range(chats):
            index.retain(dict(id=f'chat-{chat:06}', title=f'Conversation {chat}', project=f'Project {chat % 10}'),
                (dict(id=f'message-{message}', type='agentMessage', turnId=f'turn-{message}',
                      text=f'Message {message} in conversation {chat}. ' + 'Retained discussion with code and project context. ' * 8 +
                      (' pineapple migration needle' if chat % 100 == 0 and message == messages - 1 else ''))
                 for message in range(messages)))
        ingest_seconds = time.perf_counter() - start
        with db:
            index.set_state('local:done', 1)
        searches = {}
        for query in ('"pineapple migration"', 'needle', 'message', 'absentword'):
            times, result = [], None
            for _ in range(5):
                start = time.perf_counter()
                result = await index.search(dict(query=query, limit=25))
                times.append(1000 * (time.perf_counter() - start))
            searches[query] = dict(median_ms=round(statistics.median(times), 2), max_ms=round(max(times), 2),
                                   results=len(result['results']), bounded=result.get('bounded', False))
        print(json.dumps(dict(chats=chats, messages=chats * messages, ingestion_seconds=round(ingest_seconds, 2),
            database_mib=round(path.stat().st_size / 1024**2, 2), initial_memory=initial_memory, final_memory=memory_mib(), searches=searches), indent=2))
        await index.close()
        db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chats', type=int, default=1000)
    parser.add_argument('--messages', type=int, default=100)
    args = parser.parse_args()
    if args.chats < 1 or args.messages < 1:
        parser.error('Chat and message counts must be positive')
    asyncio.run(main(args.chats, args.messages))
