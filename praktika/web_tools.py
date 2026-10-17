"""Small, bounded public web reader. Does not use local credentials or proxies."""

import http.client
import ipaddress
import socket
from html.parser import HTMLParser
from urllib.parse import urlencode, urljoin, urlsplit
from xml.etree import ElementTree


def public_address(host, port):
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError("Доступны только публичные сайты в интернете")
    return addresses[0][4][0]


def fetch(url):
    for _ in range(5):
        parsed = urlsplit(url)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            raise ValueError("Нужна публичная ссылка http или https")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if port not in (80, 443):
            raise ValueError("Нестандартный порт сайта не поддерживается")
        address = public_address(parsed.hostname, port)
        cls = (
            http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        )
        connection = cls(parsed.hostname, port, timeout=15)
        # Pin the validated IP while retaining the original host for TLS and Host.
        connection._create_connection = lambda *args, **kwargs: socket.create_connection(
            (address, port), 15
        )
        try:
            connection.request(
                "GET",
                (parsed.path or "/") + ("?" + parsed.query if parsed.query else ""),
                headers={
                    "User-Agent": "Praktika/1.0 (educational document assistant)",
                    "Accept-Encoding": "identity",
                },
            )
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    raise ValueError("Сайт вернул пустое перенаправление")
                url = urljoin(url, location)
                continue
            if response.status != 200:
                raise ValueError(f"Сайт ответил HTTP {response.status}")
            content_type = response.getheader("Content-Type", "").lower()
            if not any(t in content_type for t in ("text/", "xml", "json")):
                raise ValueError("Ссылка должна вести на текстовую страницу, не файл")
            raw = response.read(1_000_001)
            if len(raw) > 1_000_000:
                raise ValueError("Страница слишком большая (более 1 МБ)")
            charset = response.headers.get_content_charset() or "utf-8"
            try:
                return url, raw.decode(charset, errors="replace")
            except LookupError:
                return url, raw.decode("utf-8", errors="replace")
        finally:
            connection.close()
    raise ValueError("Слишком много перенаправлений сайта")


class PageText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hidden = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg"):
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg"):
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden and data.strip():
            self.parts.append(data.strip())


def read_page(url):
    final_url, html = fetch(url)
    parser = PageText()
    parser.feed(html)
    text = "\n".join(parser.parts)
    return {"url": final_url, "text": text[:18000], "truncated": len(text) > 18000}


def search_web(query):
    _, xml = fetch("https://www.bing.com/search?" + urlencode({"q": query[:300], "format": "rss"}))
    root = ElementTree.fromstring(xml)
    results = []
    for item in root.findall(".//item")[:5]:
        url = item.findtext("link", "")
        if urlsplit(url).scheme in ("http", "https"):
            results.append(
                {
                    "title": item.findtext("title", ""),
                    "url": url,
                    "snippet": item.findtext("description", "")[:1500],
                }
            )
    return {
        "results": results,
        "note": "Это поисковые фрагменты. Для проверки факта прочитай страницу через read_url.",
    }
