"""Guarded downloading of remote product images."""

from __future__ import annotations

import http.client
import ipaddress
from io import BytesIO
import mimetypes
import os
import socket
from urllib.parse import urlparse
from urllib.error import HTTPError, URLError
from urllib.request import (
    HTTPHandler,
    HTTPSHandler,
    HTTPRedirectHandler,
    Request,
    build_opener,
)


class RemoteImageError(ValueError):
    """Raised when a remote image is unsafe or invalid."""


def _validated_remote_target(url, resolver=socket.getaddrinfo):
    parsed = urlparse(str(url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RemoteImageError("Image URL must use HTTP or HTTPS.")
    try:
        addresses = {
            item[4][0].split("%", 1)[0]
            for item in resolver(
                parsed.hostname,
                parsed.port or (443 if parsed.scheme == "https" else 80),
            )
        }
    except (OSError, socket.gaierror) as exc:
        raise RemoteImageError("Image host could not be resolved.") from exc
    if not addresses:
        raise RemoteImageError("Image host did not resolve to an address.")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise RemoteImageError("Image URL resolves to a non-public network address.")
    return parsed, tuple(sorted(addresses))


def validate_remote_url(url, resolver=socket.getaddrinfo):
    parsed, _addresses = _validated_remote_target(url, resolver=resolver)
    return parsed.geturl()


class _SafeRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_remote_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, *, connect_host, **kwargs):
        self._connect_host = connect_host
        super().__init__(host, **kwargs)

    def connect(self):
        self.sock = socket.create_connection(
            (self._connect_host, self.port),
            self.timeout,
            self.source_address,
        )
        if self._tunnel_host:
            self._tunnel()


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, *, connect_host, **kwargs):
        self._connect_host = connect_host
        super().__init__(host, **kwargs)

    def connect(self):
        sock = socket.create_connection(
            (self._connect_host, self.port),
            self.timeout,
            self.source_address,
        )
        if self._tunnel_host:
            self.sock = sock
            self._tunnel()
            sock = self.sock
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _PinnedHTTPHandler(HTTPHandler):
    def http_open(self, req):
        _parsed, addresses = _validated_remote_target(req.full_url)
        connect_host = addresses[0]
        return self.do_open(
            lambda host, **kwargs: _PinnedHTTPConnection(
                host,
                connect_host=connect_host,
                **kwargs,
            ),
            req,
        )


class _PinnedHTTPSHandler(HTTPSHandler):
    def https_open(self, req):
        _parsed, addresses = _validated_remote_target(req.full_url)
        connect_host = addresses[0]
        return self.do_open(
            lambda host, **kwargs: _PinnedHTTPSConnection(
                host,
                connect_host=connect_host,
                **kwargs,
            ),
            req,
        )


def download_remote_image(url, max_bytes=10 * 1024 * 1024, timeout=15):
    """Download and minimally validate one public image URL."""
    safe_url = validate_remote_url(url)
    request = Request(
        safe_url,
        headers={"User-Agent": "InvenTree-Multi-Site-Importer/1.0"},
    )
    opener = build_opener(
        _SafeRedirectHandler(),
        _PinnedHTTPHandler(),
        _PinnedHTTPSHandler(),
    )
    try:
        with opener.open(request, timeout=timeout) as response:
            content_type = response.headers.get_content_type().lower()
            if not content_type.startswith("image/"):
                raise RemoteImageError("Remote URL did not return an image content type.")
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > max_bytes:
                raise RemoteImageError("Remote image exceeds the configured size limit.")
            data = response.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise RemoteImageError("Remote image exceeds the configured size limit.")
            final_url = validate_remote_url(response.geturl())
    except RemoteImageError:
        raise
    except HTTPError as exc:
        raise RemoteImageError(f"Remote image returned HTTP {exc.code}.") from exc
    except URLError as exc:
        reason = getattr(exc, "reason", None)
        if isinstance(reason, socket.timeout):
            raise RemoteImageError("Remote image download timed out.") from exc
        raise RemoteImageError("Remote image connection failed.") from exc
    except socket.timeout as exc:
        raise RemoteImageError("Remote image download timed out.") from exc
    except Exception as exc:
        raise RemoteImageError("Remote image could not be downloaded.") from exc

    try:
        from PIL import Image

        Image.open(BytesIO(data)).verify()
    except Exception as exc:
        raise RemoteImageError("Remote response is not a valid image file.") from exc

    filename = os.path.basename(urlparse(final_url).path) or "product-image"
    extension = os.path.splitext(filename)[1]
    if not extension:
        extension = mimetypes.guess_extension(content_type) or ".img"
        filename = f"{filename}{extension}"
    return filename[:240], data, content_type, final_url
