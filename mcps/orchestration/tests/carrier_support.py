"""Private, disposable real Carrier service for orchestration tests."""

import asyncio
import os
import socket
import threading
from unittest.mock import patch


async def start_carrier(case, root):
    import uvicorn
    from carrier.service import create_app

    database = root / "carrier.db"
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    url = "http://127.0.0.1:" + str(sock.getsockname()[1])
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(str(database)), log_level="critical", lifespan="off", ws="none"
        )
    )
    thread = threading.Thread(
        target=server.run, kwargs={"sockets": [sock]}, daemon=True
    )
    thread.start()
    async with asyncio.timeout(5):
        while not server.started:
            await asyncio.sleep(0.01)
    environment = patch.dict(
        os.environ, CARRIER_DATABASE=str(database), CARRIER_URL=url
    )
    environment.start()
    case.addCleanup(environment.stop)

    async def stop():
        server.should_exit = True
        await asyncio.to_thread(thread.join, 5)
        sock.close()
        if thread.is_alive():
            raise RuntimeError("Fixture Carrier service did not stop")

    case.addAsyncCleanup(stop)
    return database, url
