"""Suite-owned device registry and transfer journal. SQLite stays on the event loop."""
import asyncio
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import threading
import time
from urllib.parse import quote, urlsplit
import uuid

from .protocol import CHUNK, MAX_FILE, PORT, ConnectError, address, filename, identifier, request, response_json

ACTIVE = {"preparing", "sending", "cancelling"}


def label(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 128 or any(ord(c) < 32 for c in value):
        raise ConnectError("Use a device name between 1 and 128 characters")
    return value.strip()


def api_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path.rstrip("/") not in ("", "/api")):
        raise ConnectError("Use an HTTPS NetBird API URL, such as https://api.netbird.io/api")
    return value.rstrip("/") + ("/api" if not parsed.path.rstrip("/") else "")


def netbird_peers(url, token):
    parsed = urlsplit(api_url(url))
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port, timeout=8)
    try:
        connection.request("GET", parsed.path + "/peers", headers={"Authorization": "Token " + token, "Accept": "application/json"})
        response = connection.getresponse()
        if response.status != 200:
            raise ConnectError(f"NetBird rejected the request ({response.status}); check the API URL and token permissions")
        result = response_json(response)
        if not isinstance(result, list) or len(result) > 10000:
            raise ConnectError("NetBird returned an invalid peer list")
        peers = []
        for peer in result:
            try:
                peers.append({"id": str(peer["id"])[:128], "name": label(peer["name"]),
                              "ip": address(peer["ip"]), "os": str(peer.get("os", ""))[:128],
                              "connected": peer.get("connected") is True})
            except (ValueError, KeyError, TypeError):
                continue
        return peers
    except (OSError, http.client.HTTPException):
        raise ConnectError("Could not reach the NetBird API") from None
    finally:
        connection.close()


class Control:
    def __init__(self):
        self.stop = threading.Event()
        self.connection = None
        self.lock = threading.Lock()

    def cancel(self):
        self.stop.set()
        with self.lock:
            connection = self.connection
            if connection and connection.sock:
                try:
                    connection.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass


def open_source(root, source):
    """Pin every directory and the file on the Linux Suite host; reject link escapes."""
    root = Path(root).resolve(strict=True)
    path = Path(source)
    if path.is_absolute():
        try:
            path = path.relative_to(root)
        except ValueError:
            raise ConnectError("The source file must be inside this chat's project") from None
    if not path.parts or ".." in path.parts:
        raise ConnectError("The source file must be inside this chat's project")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        file_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        info = os.fstat(file_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
            os.close(file_fd)
            raise ConnectError("Select one regular file up to 20 GiB")
        return os.fdopen(file_fd, "rb"), info
    finally:
        os.close(fd)


class Connect:
    def __init__(self, db, output, get_chat, *, peers_fetch=netbird_peers, allow_loopback=False):
        self.db, self.output, self.get_chat = db, output, get_chat
        self.peers_fetch, self.allow_loopback = peers_fetch, allow_loopback
        self.tasks, self.controls = {}, {}
        self.closing = False
        self.config_lock = asyncio.Lock()
        self.device_lock = asyncio.Lock()
        with db:
            db.execute("CREATE TABLE IF NOT EXISTS connect_settings (id INTEGER PRIMARY KEY, record TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS connect_devices (id TEXT PRIMARY KEY, record TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS connect_transfers (id TEXT PRIMARY KEY, chat TEXT NOT NULL, signature TEXT NOT NULL, record TEXT NOT NULL)")
            db.execute("CREATE INDEX IF NOT EXISTS connect_transfer_signature ON connect_transfers(signature)")
            db.execute("CREATE INDEX IF NOT EXISTS connect_transfer_chat ON connect_transfers(chat)")
        for (raw,) in db.execute("SELECT record FROM connect_transfers").fetchall():
            row = json.loads(raw)
            if row["status"] in ACTIVE:
                row.update(status="uncertain" if row["status"] != "preparing" else "failed",
                           error="Suite restarted. Check delivery before retrying." if row["status"] != "preparing" else "Suite restarted before sending the file.")
                self.save(row, emit=False)

    def config(self):
        row = self.db.execute("SELECT record FROM connect_settings WHERE id=1").fetchone()
        return json.loads(row[0]) if row else None

    def settings(self):
        config = self.config()
        return {"configured": bool(config), "apiUrl": config["apiUrl"] if config else "https://api.netbird.io/api"}

    async def peers(self):
        config = self.config()
        if not config:
            return []
        return await asyncio.to_thread(self.peers_fetch, config["apiUrl"], config["token"])

    def devices(self):
        return [json.loads(row[0]) for row in self.db.execute("SELECT record FROM connect_devices")]

    def device(self, key):
        row = self.db.execute("SELECT record FROM connect_devices WHERE id=?", (identifier(key),)).fetchone()
        if not row:
            raise ConnectError("Device was not found; pair it in Settings → Devices")
        return json.loads(row[0])

    def save_device(self, device):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO connect_devices VALUES (?,?)", (device["id"], json.dumps(device)))

    @staticmethod
    def public_device(device):
        return {key: device.get(key) for key in ("id", "peerId", "name", "ip", "port", "os", "receiveDir", "instanceId", "paired")}

    def verify_info(self, device, info):
        if (not isinstance(info, dict) or info.get("protocol") != 1 or info.get("instanceId") != device.get("instanceId")
                or info.get("receiveDir") != device.get("receiveDir") or type(info.get("maxBytes")) is not int
                or info["maxBytes"] < 0):
            raise ConnectError("The companion identity or receiving folder changed. Pair this device again")

    async def listing(self):
        peers = {peer["id"]: peer for peer in await self.peers()}
        semaphore = asyncio.Semaphore(4)

        async def inspect(device):
            value = self.public_device(device)
            peer = peers.get(device["peerId"])
            value.update(online=False, status="offline", error=None)
            if not device.get("paired"):
                value.update(status="pairing-required", error="Finish pairing this device")
            elif peer and peer["ip"] != device["ip"]:
                value.update(status="pairing-required", error="NetBird address changed; pair this device again")
            elif peer and peer["connected"]:
                async with semaphore:
                    try:
                        info = await asyncio.to_thread(request, device["ip"], device["port"], device["token"], "GET", "/v1/info")
                        self.verify_info(device, info)
                        value.update(online=True, status="ready", capabilities=info.get("capabilities", {"files": True, "codex": False}))
                    except (OSError, ValueError, http.client.HTTPException):
                        value.update(status="unreachable", error="Companion unavailable. Check its process, pairing, and NetBird access policy")
            return value
        return {**self.settings(), "devices": await asyncio.gather(*(inspect(device) for device in self.devices()))}

    async def configure(self, args):
        url, token = api_url(args["apiUrl"]), args["token"].strip()
        if not 16 <= len(token) <= 4096 or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ConnectError("Enter a valid NetBird API token")
        async with self.config_lock:
            if self.config() and self.config()["apiUrl"] != url and self.devices():
                raise ConnectError("Remove paired devices before switching NetBird accounts or API hosts")
            await asyncio.to_thread(self.peers_fetch, url, token)
            with self.db:
                self.db.execute("INSERT OR REPLACE INTO connect_settings VALUES (1,?)", (json.dumps({"apiUrl": url, "token": token}),))
        return self.settings()

    async def pair(self, args):
        async with self.device_lock:
            if self.tasks:
                raise ConnectError("Wait for active transfers before pairing devices")
            peer = next((p for p in await self.peers() if p["id"] == args["peerId"]), None)
            if not peer or not peer["connected"]:
                raise ConnectError("Select an online device from your NetBird peer list")
            host = address(peer["ip"], loopback=self.allow_loopback)
            port, name, key = args.get("port", PORT), label(args["name"]), identifier(args["key"])
            if type(port) is not int or not 1 <= port <= 65535:
                raise ConnectError("Invalid companion port")
            if not re.fullmatch(r"[A-Za-z0-9_-]{43}", args["code"]):
                raise ConnectError("Enter the companion's one-time pairing code")
            devices = self.devices()
            previous = next((d for d in devices if d["peerId"] == peer["id"]), None)
            if any(d["name"].casefold() == name.casefold() and d != previous for d in devices):
                raise ConnectError("Choose a unique device name")
            if not previous and len(devices) >= 16:
                raise ConnectError("This MVP supports up to 16 paired devices")
            device = {"id": previous["id"] if previous else str(uuid.uuid4()), "peerId": peer["id"], "ip": host,
                      "port": port, "name": name, "paired": False, "pairKey": key,
                      "token": previous["token"] if previous and previous.get("pairKey") == key else secrets.token_urlsafe(32)}
            self.save_device(device)  # Retain credential before contacting the receiver.
            try:
                info = await asyncio.to_thread(request, host, port, args["code"], "POST", "/v1/pair", {"token": device["token"]})
            except (OSError, ValueError, http.client.HTTPException):
                try:
                    # A lost pairing response must not force another credential exchange.
                    info = await asyncio.to_thread(request, host, port, device["token"], "GET", "/v1/info")
                except (OSError, ValueError, http.client.HTTPException):
                    raise ConnectError("Could not pair. Check the companion, NetBird policy, and pairing code; retry or generate a new code") from None
            if not isinstance(info, dict) or info.get("protocol") != 1:
                raise ConnectError("Unsupported companion protocol")
            identifier(info["instanceId"])
            if not isinstance(info.get("receiveDir"), str) or len(info["receiveDir"]) > 4096:
                raise ConnectError("Invalid companion receiving folder")
            device.update(instanceId=info["instanceId"], receiveDir=info["receiveDir"], os=str(info.get("os", ""))[:128], paired=True)
            self.save_device(device)
            return self.public_device(device)

    def get(self, key, chat_id=None):
        row = self.db.execute("SELECT record FROM connect_transfers WHERE id=?", (identifier(key),)).fetchone()
        value = json.loads(row[0]) if row else None
        if not value or chat_id and value["chatId"] != chat_id:
            raise ConnectError("Transfer was not found in this conversation")
        return value

    def transfers(self, chat_id=None):
        rows = self.db.execute("SELECT record FROM connect_transfers" + (" WHERE chat=?" if chat_id else "") +
                               " ORDER BY rowid DESC LIMIT 100", (chat_id,) if chat_id else ()).fetchall()
        return [json.loads(row[0]) for row in rows]

    def pending_for(self, device_id):
        # Enforcement must include old uncertain operations outside the UI's history page.
        return [row for (raw,) in self.db.execute("SELECT record FROM connect_transfers")
                if (row := json.loads(raw))["deviceId"] == device_id and row["status"] in ACTIVE | {"uncertain"}]

    def save(self, row, *, emit=True):
        row["revision"] = row.get("revision", 0) + 1
        row["updatedAt"] = time.time() * 1000
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO connect_transfers VALUES (?,?,?,?)",
                            (row["id"], row["chatId"], row["signature"], json.dumps(row)))
        if emit:
            self.output({"type": "connect-transfer-updated", "transfer": dict(row)})

    def progress(self, key, changes):
        row = self.get(key)
        if row["status"] not in ACTIVE or row["status"] == "cancelling":
            return
        row.update(changes)
        self.save(row)

    async def send(self, source, args, turn=None, call=None):
        if self.closing:
            raise ConnectError("Aixand Connect is shutting down")
        if self.device_lock.locked():
            raise ConnectError("Wait for device pairing to finish before sending")
        if not source.get("projectId"):
            raise ConnectError("Open a chat in a saved project before sending a file")
        project = self.db.execute("SELECT path FROM projects WHERE id=?", (source["projectId"],)).fetchone()
        if not project or Path(project[0]).resolve() != Path(source["cwd"]).resolve():
            raise ConnectError("This chat's saved project is unavailable or has moved")
        device = self.device(args["deviceId"])
        if not device.get("paired"):
            raise ConnectError("Finish pairing this device first")
        path = args["path"]
        if not isinstance(path, str) or not 1 <= len(path) <= 4096 or "\x00" in path:
            raise ConnectError("Select a file inside the current project")
        name = filename(args.get("name") or Path(path).name)
        signature = hashlib.sha256(json.dumps([source["id"], turn or args.get("key"), device["id"], path, name]).encode()).hexdigest()
        previous = self.db.execute("SELECT record FROM connect_transfers WHERE signature=?", (signature,)).fetchone()
        if previous:
            return {**json.loads(previous[0]), "accepted": True}
        if any(row["name"] == name for row in self.pending_for(device["id"])):
            raise ConnectError("A transfer to that filename is active or unconfirmed. Inspect it before sending again")
        if len(self.tasks) >= 4:
            raise ConnectError("Four transfers are already active; wait for one to finish")
        # Validate source before accepting, without hashing on the event loop.
        try:
            stream, info = open_source(project[0], path)
            stream.close()
        except OSError:
            raise ConnectError("Source is unavailable or contains a symbolic link; select a regular project file") from None
        now = time.time() * 1000
        row = {"id": str(uuid.uuid4()), "chatId": source["id"], "sourceTurnId": turn, "sourceCallId": call,
               "deviceId": device["id"], "device": device["name"], "source": path, "name": name,
               "status": "preparing", "bytesSent": 0, "size": info.st_size, "sha256": None,
               "destination": None, "error": None, "createdAt": now, "signature": signature}
        self.save(row)
        control = self.controls[row["id"]] = Control()
        task = asyncio.create_task(self.run(row["id"], project[0], device, control))
        self.tasks[row["id"]] = task
        task.add_done_callback(lambda _task: (self.tasks.pop(row["id"], None), self.controls.pop(row["id"], None)))
        return {**row, "accepted": True}

    def transfer(self, row, root, device, control, progress):
        attempted = False
        try:
            with open_source(root, row["source"])[0] as stream:
                before = os.fstat(stream.fileno())
                checksum = hashlib.sha256()
                while data := stream.read(CHUNK):
                    if control.stop.is_set():
                        return {"status": "cancelled", "error": "Cancelled before sending"}
                    checksum.update(data)
                after = os.fstat(stream.fileno())
                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    raise ConnectError("Source changed while preparing the transfer; retry when it is stable")
                sha256 = checksum.hexdigest()
                info = request(device["ip"], device["port"], device["token"], "GET", "/v1/info")
                self.verify_info(device, info)
                if before.st_size > info["maxBytes"]:
                    raise ConnectError("File exceeds this device's receiving limit")
                request(device["ip"], device["port"], device["token"], "POST", "/v1/validate",
                        {"name": row["name"], "size": before.st_size})
                if control.stop.is_set():
                    return {"status": "cancelled", "error": "Cancelled before sending"}
                progress({"status": "sending", "sha256": sha256, "size": before.st_size})
                stream.seek(0)
                connection = http.client.HTTPConnection(device["ip"], device["port"], timeout=30)
                with control.lock:
                    control.connection = connection
                try:
                    attempted = True
                    connection.putrequest("PUT", "/v1/transfers/" + row["id"])
                    for key, value in {"Authorization": "Bearer " + device["token"], "Content-Length": str(before.st_size),
                                       "X-Filename": quote(row["name"], safe=""), "X-SHA256": sha256,
                                       "Connection": "close"}.items():
                        connection.putheader(key, value)
                    connection.endheaders()
                    sent, last = 0, 0
                    while sent < before.st_size:
                        if control.stop.is_set():
                            raise ConnectError("Cancelled")
                        data = stream.read(min(CHUNK, before.st_size - sent))
                        if not data:
                            raise ConnectError("Source changed during transfer")
                        connection.send(data); sent += len(data)
                        if time.monotonic() - last >= 0.25:
                            progress({"bytesSent": sent}); last = time.monotonic()
                    receipt = response_json(connection.getresponse())
                    return self.receipt(row, receipt, sha256, before.st_size)
                finally:
                    with control.lock:
                        control.connection = None
                    connection.close()
        except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException) as error:
            if attempted:
                try:
                    receipt = request(device["ip"], device["port"], device["token"], "DELETE" if control.stop.is_set() else "GET", "/v1/transfers/" + row["id"])
                    return self.receipt(row, receipt, sha256, before.st_size)
                except (OSError, ValueError, http.client.HTTPException):
                    return {"status": "uncertain", "sha256": sha256, "size": before.st_size,
                            "error": "Connection lost. Check delivery before retrying; the destination may have received the file"}
            return {"status": "cancelled" if control.stop.is_set() else "failed",
                    "error": str(error) if isinstance(error, ConnectError) else "Device or source unavailable. Check the companion and NetBird connection"}

    @staticmethod
    def receipt(row, receipt, sha256, size):
        if not isinstance(receipt, dict) or receipt.get("id") != row["id"]:
            raise ConnectError("Invalid delivery receipt")
        if receipt.get("status") == "completed":
            if receipt.get("sha256") != sha256 or receipt.get("size") != size or receipt.get("name") != row["name"]:
                raise ConnectError("Delivery receipt does not match the source file")
            return {"status": "completed", "sha256": sha256, "size": size, "bytesSent": size,
                    "destination": receipt["destination"], "error": None}
        if receipt.get("status") in ("failed", "cancelled"):
            return {"status": receipt["status"], "sha256": sha256, "error": str(receipt.get("error") or "Transfer failed")[:300]}
        return {"status": "uncertain", "sha256": sha256, "error": "Receiver has not confirmed completion. Check delivery again before retrying"}

    async def run(self, key, root, device, control):
        loop = asyncio.get_running_loop()
        try:
            peer = next((p for p in await self.peers() if p["id"] == device["peerId"]), None)
            if not peer or not peer["connected"] or peer["ip"] != device["ip"]:
                raise ConnectError("Device is offline or its NetBird address changed; check Devices settings")
            result = await asyncio.to_thread(self.transfer, self.get(key), root, device, control,
                                           lambda changes: loop.call_soon_threadsafe(self.progress, key, changes))
        except Exception as error:
            result = {"status": "failed", "error": str(error) if isinstance(error, ConnectError) else "Transfer could not start"}
        row = self.get(key)
        row.update(result)
        self.save(row)

    async def cancel(self, key, chat_id=None):
        row = self.get(key, chat_id)
        control = self.controls.get(key)
        if control and row["status"] in ACTIVE:
            control.cancel()
            row.update(status="cancelling", error=None)
            self.save(row)
        elif row["status"] == "uncertain":
            return await self.check(key, chat_id, cancel=True)
        return row

    async def check(self, key, chat_id=None, *, cancel=False):
        row = self.get(key, chat_id)
        if row["status"] != "uncertain":
            return row
        device = self.device(row["deviceId"])
        try:
            peer = next((p for p in await self.peers() if p["id"] == device["peerId"]), None)
            if not peer or not peer["connected"] or peer["ip"] != device["ip"]:
                raise ConnectError("Device is offline or its NetBird address changed")
            info = await asyncio.to_thread(request, device["ip"], device["port"], device["token"], "GET", "/v1/info")
            self.verify_info(device, info)
            receipt = await asyncio.to_thread(request, device["ip"], device["port"], device["token"], "DELETE" if cancel else "GET", "/v1/transfers/" + key)
            row.update(self.receipt(row, receipt, row["sha256"], row["size"]))
            self.save(row)
        except (OSError, ValueError, http.client.HTTPException):
            raise ConnectError("Delivery is still unconfirmed. Check the companion before retrying") from None
        return row

    async def execute(self, op, args):
        if op == "connect-status":
            return self.settings()
        if op == "connect-configure":
            return await self.configure(args)
        if op == "connect-peers":
            return {"peers": await self.peers()}
        if op == "connect-devices":
            return await self.listing()
        if op == "connect-pair":
            return await self.pair(args)
        if op == "connect-forget":
            if self.device_lock.locked():
                raise ConnectError("Wait for pairing to finish before removing a device")
            device = self.device(args["deviceId"])
            if self.pending_for(device["id"]):
                raise ConnectError("Resolve active or uncertain transfers before removing this device")
            with self.db:
                self.db.execute("DELETE FROM connect_devices WHERE id=?", (device["id"],))
            return {"removed": True}
        if op == "connect-transfers":
            return {"transfers": self.transfers(args.get("chatId"))}
        if op == "connect-send":
            return await self.send(self.get_chat(args["chatId"]), args)
        if op == "connect-cancel":
            return await self.cancel(args["transferId"], args.get("chatId"))
        if op == "connect-check":
            return await self.check(args["transferId"], args.get("chatId"))
        raise ConnectError("Unknown Connect action")

    async def tool(self, name, args, source, turn, call):
        if name == "list_devices":
            return await self.listing()
        if name == "send_file":
            return await self.send(source, args, turn, call)
        if name == "get_file_transfer":
            return await self.check(args["transferId"], source["id"])
        if name == "cancel_file_transfer":
            return await self.cancel(args["transferId"], source["id"])
        raise ConnectError("Unknown Connect tool")

    async def close(self):
        self.closing = True
        for control in self.controls.values():
            control.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)
