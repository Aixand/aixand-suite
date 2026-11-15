"""Shared validation and bounded HTTP; never use ambient proxies or redirects."""
import http.client
import ipaddress
import json
import re
import uuid

PORT = 47831
CHUNK = 256 * 1024
MAX_FILE = 20 * 1024**3
MAX_JSON = 2 * 1024**2


class ConnectError(ValueError):
    code = "connect"


def identifier(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ConnectError("Invalid operation identity")
    return value


def filename(value):
    if (not isinstance(value, str) or not value or len(value.encode("utf-8")) > 200
            or value in (".", "..") or value.startswith(".aixand-connect")
            or value[-1] in " ." or any(ord(c) < 32 or ord(c) == 127 or c in '/\\:<>"|?*' for c in value)
            or re.match(r"^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)", value, re.I)):
        raise ConnectError("Choose a plain filename valid on Windows, macOS, and Linux")
    return value


def address(value, *, loopback=False):
    ip = ipaddress.IPv4Address(value)
    private = any(ip in ipaddress.ip_network(net) for net in
                  ("100.64.0.0/10", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
    if not private and not (loopback and ip.is_loopback):
        raise ConnectError("Use this device's private NetBird IPv4 address")
    return str(ip)


def response_json(response):
    body = response.read(MAX_JSON + 1)
    if len(body) > MAX_JSON:
        raise ConnectError("Device response exceeded its limit")
    try:
        result = json.loads(body)
    except (ValueError, UnicodeError):
        raise ConnectError("Device returned an invalid response") from None
    if not 200 <= response.status < 300:
        message = result.get("error") if isinstance(result, dict) else None
        raise ConnectError(str(message or f"Request failed ({response.status})")[:300])
    return result


def request(host, port, token, method, path, body=None, *, timeout=5):
    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        headers = {"Authorization": "Bearer " + token, "Connection": "close"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        connection.request(method, path, json.dumps(body).encode() if body is not None else None, headers)
        return response_json(connection.getresponse())
    finally:
        connection.close()
