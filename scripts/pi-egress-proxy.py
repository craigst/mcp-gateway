#!/usr/bin/env python3
"""Small authenticated SOCKS5 CONNECT proxy for the UK home egress.

Only the mcp-gateway VPS uses it. It is bound to the LAN/WireGuard address, not
the public WAN, and supports username/password authentication (RFC 1929).
"""
from __future__ import annotations

import asyncio
import hmac
import ipaddress
import logging
import os
import socket
import struct

BIND = os.environ.get("PROXY_BIND", "10.10.254.85")
PORT = int(os.environ.get("PROXY_PORT", "1080"))
USER = os.environ.get("PROXY_USER", "")
PASSWORD = os.environ.get("PROXY_PASSWORD", "")
ALLOW_PRIVATE = os.environ.get("PROXY_ALLOW_PRIVATE", "1") == "1"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pi-egress")


async def read_exact(reader: asyncio.StreamReader, n: int) -> bytes:
    data = await reader.readexactly(n)
    return data


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    peer = writer.get_extra_info("peername")
    peer_ip = peer[0] if peer else "?"
    try:
        if ALLOW_PRIVATE:
            try:
                if not ipaddress.ip_address(peer_ip).is_private:
                    log.warning("rejecting non-private peer %s", peer_ip)
                    writer.close()
                    return
            except ValueError:
                pass
        ver, nmethods = await read_exact(reader, 2)
        if ver != 5:
            writer.close()
            return
        methods = await read_exact(reader, nmethods)
        if 2 not in methods:
            writer.write(b"\x05\xff")
            await writer.drain()
            writer.close()
            return
        writer.write(b"\x05\x02")
        await writer.drain()
        aver, ulen = await read_exact(reader, 2)
        if aver != 1:
            writer.close()
            return
        user = (await read_exact(reader, ulen)).decode("utf-8", "replace")
        plen = (await read_exact(reader, 1))[0]
        password = (await read_exact(reader, plen)).decode("utf-8", "replace")
        if not (hmac.compare_digest(user, USER) and hmac.compare_digest(password, PASSWORD)):
            writer.write(b"\x01\x01")
            await writer.drain()
            log.warning("auth failed from %s", peer_ip)
            writer.close()
            return
        writer.write(b"\x01\x00")
        await writer.drain()
        ver, cmd, _rsv, atyp = await read_exact(reader, 4)
        if ver != 5 or cmd != 1:
            writer.write(b"\x05\x07\x00\x01\x00\x00\x00\x00\x00\x00")
            await writer.drain()
            writer.close()
            return
        if atyp == 1:
            host = socket.inet_ntoa(await read_exact(reader, 4))
        elif atyp == 3:
            length = (await read_exact(reader, 1))[0]
            host = (await read_exact(reader, length)).decode("idna")
        elif atyp == 4:
            host = socket.inet_ntop(socket.AF_INET6, await read_exact(reader, 16))
        else:
            writer.write(b"\x05\x08\x00\x01\x00\x00\x00\x00\x00\x00")
            await writer.drain()
            writer.close()
            return
        port = struct.unpack("!H", await read_exact(reader, 2))[0]
        try:
            upstream_reader, upstream_writer = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=15
            )
        except Exception as exc:
            log.warning("connect %s:%s failed: %s", host, port, type(exc).__name__)
            writer.write(b"\x05\x05\x00\x01\x00\x00\x00\x00\x00\x00")
            await writer.drain()
            writer.close()
            return
        writer.write(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
        await writer.drain()
        await asyncio.gather(
            pipe(reader, upstream_writer),
            pipe(upstream_reader, writer),
            return_exceptions=True,
        )
        try:
            upstream_writer.close()
        except Exception:
            pass
    except (asyncio.IncompleteReadError, ConnectionError, asyncio.CancelledError):
        pass
    except Exception as exc:
        log.warning("connection from %s failed: %s", peer_ip, type(exc).__name__)
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def main() -> None:
    if not USER or not PASSWORD:
        raise SystemExit("PROXY_USER/PROXY_PASSWORD are required")
    server = await asyncio.start_server(handle, BIND, PORT, reuse_address=True)
    log.info("SOCKS5 proxy listening on %s:%s", BIND, PORT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
