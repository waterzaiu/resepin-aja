"""Additional public recipe indexes; return links and thumbnails, never copied recipes.

SECURITY / RELIABILITY NOTES
---------------------------
The HTML scraping adapters in this module (Allrecipes and detikFood) are
FRAGILE and UNSTABLE. They parse third-party HTML that can change without
notice, and scraping copyrighted recipe pages is legally and operationally
risky. They are therefore DISABLED BY DEFAULT and isolated behind an explicit
feature flag:

    RECIPE_SCRAPING_ENABLED=1   (any non-empty value enables scraping)

When disabled (the default), no outbound scraping occurs at all: the built-in
scrapers return empty results AND the caller-supplied ``search_cookpad``
callback is NOT invoked (the server-side implementation scrapes Cookpad rather
than calling an official API). This keeps the official-API discovery pipeline
(recipe_discovery.py) unaffected while never issuing outbound requests to
third-party sites unless an operator opts in.

Other hardening applied here:

* The result cache is bounded by BOTH a TTL and a maximum entry count; expired
  entries are evicted on access, and the oldest entries are evicted when the
  cap is exceeded. See ``_CACHE_TTL_SECONDS`` and ``_CACHE_MAX_ENTRIES``.
* Outbound searches are limited by ``_MAX_CONCURRENT_SEARCHES`` (a global
  semaphore) and per-source query caps so a hostile or runaway caller cannot
  spawn unbounded network I/O.
* Every result URL and thumbnail hostname is validated against an allowlist
  before it is returned (see ``_ALLOWED_*_HOSTS``); anything else is dropped.
* Every fetch/parse failure degrades gracefully to an empty result for that
  source and never aborts the other sources.
"""

from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import os
import re
import sys
import threading
import time
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

# ---------------------------------------------------------------------------
# Tunables (bounded-resource and feature-flag controls)
# ---------------------------------------------------------------------------

# Feature flag: built-in HTML scrapers are disabled unless explicitly enabled.
SCRAPING_ENABLED = bool(os.environ.get("RECIPE_SCRAPING_ENABLED", "").strip())

# Cache bounds. Expired entries are evicted on read; the cap bounds memory.
_CACHE_TTL_SECONDS = 600
_CACHE_MAX_ENTRIES = 256

# Outbound concurrency bound and per-source query caps.
_MAX_CONCURRENT_SEARCHES = int(os.environ.get("RECIPE_MAX_CONCURRENT_SEARCHES", "3"))
_MAX_QUERY_WORDS_ALLRECIPES = 2
_MAX_QUERY_WORDS_DETIK = 8

# Hostname allowlists. Result URLs and thumbnail URLs MUST resolve to a host
# (or subdomain) in these sets, otherwise the card is discarded.
_ALLOWED_RESULT_HOSTS = {
    "allrecipes.com",
    "food.detik.com",
}
_ALLOWED_THUMBNAIL_HOSTS = {
    "allrecipes.com",
    "akcdn.detik.net.id",
}

_TRANSLATE = {"ayam": "chicken", "telur": "egg", "kentang": "potato", "nasi": "rice", "mie": "noodles", "mi": "noodles", "ikan": "fish", "udang": "shrimp", "daging": "beef", "tomat": "tomato", "jamur": "mushroom", "wortel": "carrot", "bayam": "spinach", "tahu": "tofu", "kacang": "beans", "pisang": "banana", "keju": "cheese", "roti": "bread"}
_CACHE = {}
_LOCK = threading.Lock()
_SEARCH_SEMAPHORE = threading.BoundedSemaphore(_MAX_CONCURRENT_SEARCHES)


def _host_allowed(url, allowed_hosts):
    """Return True if ``url`` parses and its hostname is in ``allowed_hosts``.

    A hostname matches if it equals an allowlisted host or is a subdomain of
    one (e.g. ``www.allrecipes.com`` matches ``allrecipes.com``). Ports are
    accepted; anything unparseable or unexpected is rejected.
    """
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    if not host:
        return False
    for allowed in allowed_hosts:
        if host == allowed or host.endswith("." + allowed):
            return True
    return False


def _cache_get(cache_key):
    """Read a non-expired cache entry, evicting expired entries as we go."""
    with _LOCK:
        cached = _CACHE.get(cache_key)
        if cached is None:
            return None
        if time.monotonic() - cached[0] >= _CACHE_TTL_SECONDS:
            del _CACHE[cache_key]
            return None
        return [dict(card) for card in cached[1]]


def _cache_put(cache_key, cards):
    """Store cards, enforcing the max-entry cap by evicting oldest entries."""
    with _LOCK:
        _CACHE[cache_key] = (time.monotonic(), [dict(card) for card in cards])
        while len(_CACHE) > _CACHE_MAX_ENTRIES:
            oldest_key = min(_CACHE, key=lambda k: _CACHE[k][0])
            del _CACHE[oldest_key]


def _evict_expired():
    """Drop all expired entries (bounded maintenance sweep)."""
    now = time.monotonic()
    with _LOCK:
        for key in [k for k, (t, _) in _CACHE.items() if now - t >= _CACHE_TTL_SECONDS]:
            del _CACHE[key]


def _fetch(url):
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36"})
    with urlopen(req, timeout=6) as response:
        return response.read(1_800_000).decode("utf-8", "replace")


class _Allrecipes(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cards = []
        self.card = None
        self.depth = 0
        self.title_depth = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "a" and re.fullmatch(r"https://www\.allrecipes\.com/recipe/\d+/[^/?#]+/?", a.get("href", "")) and self.card is None:
            self.card = {"nama": "", "thumbnail": "", "url": a["href"], "source": "Allrecipes"}
            self.depth = 1
        elif self.card is not None:
            if tag == "a":
                self.depth += 1
            if tag == "span" and "card__title-text" in a.get("class", "").split():
                self.title_depth += 1
            if tag == "img" and not self.card["thumbnail"]:
                image = a.get("data-src") or a.get("src", "")
                if image.startswith("https://www.allrecipes.com/thmb/"):
                    self.card["thumbnail"] = image

    def handle_data(self, text):
        if self.card is not None and self.title_depth:
            self.card["nama"] += text

    def handle_endtag(self, tag):
        if self.card is not None:
            if tag == "span" and self.title_depth:
                self.title_depth -= 1
            if tag == "a":
                self.depth -= 1
                if not self.depth:
                    self.card["nama"] = self.card["nama"].strip()
                    if self.card["nama"] and self.card["thumbnail"]:
                        self.cards.append(self.card)
                    self.card = None


class _Detik(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cards = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        url = a.get("i-link", "")
        image = a.get("i-img", "")
        if tag == "article" and re.fullmatch(r"https://food\.detik\.com/resep/d-\d+/[^/?#]+", url) and image.startswith("https://akcdn.detik.net.id/"):
            title = re.sub(r"^\d+\s+", "", urlparse(url).path.rsplit("/", 1)[-1].replace("-", " ")).title()
            self.cards.append({"nama": title, "thumbnail": image + "?w=400&q=80", "url": url, "source": "detikFood"})


def search_allrecipes(query, limit=8):
    if not SCRAPING_ENABLED:
        return []
    words = [_TRANSLATE[w] for w in re.findall(r"[a-z]+", query.lower()) if w in _TRANSLATE]
    # Indonesian specialties without an English ingredient should not return unrelated Western recipes.
    if not words:
        return []
    parser = _Allrecipes()
    try:
        with _SEARCH_SEMAPHORE:
            parser.feed(_fetch("https://www.allrecipes.com/search?q=" + quote(" ".join(words[:_MAX_QUERY_WORDS_ALLRECIPES]))))
        return [c for c in parser.cards if _host_allowed(c["url"], _ALLOWED_RESULT_HOSTS) and _host_allowed(c["thumbnail"], _ALLOWED_THUMBNAIL_HOSTS)][:limit]
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"Allrecipes lookup gagal: {exc}\n")
        return []


def search_detik(query, limit=6):
    if not SCRAPING_ENABLED:
        return []
    parser = _Detik()
    try:
        with _SEARCH_SEMAPHORE:
            parser.feed(_fetch("https://food.detik.com/resep"))
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"detikFood lookup gagal: {exc}\n")
        return []
    words = [w for w in re.findall(r"[a-z]+", query.lower()) if len(w) > 2 and w not in {"resep", "masakan", "rumahan"}][:_MAX_QUERY_WORDS_DETIK]
    if not words:
        return [c for c in parser.cards if _host_allowed(c["url"], _ALLOWED_RESULT_HOSTS) and _host_allowed(c["thumbnail"], _ALLOWED_THUMBNAIL_HOSTS)][:limit]
    return [card for card in parser.cards if any(w in card["nama"].lower() for w in words) and _host_allowed(card["url"], _ALLOWED_RESULT_HOSTS) and _host_allowed(card["thumbnail"], _ALLOWED_THUMBNAIL_HOSTS)][:limit]


def mixed_recipes(query, search_cookpad, limit=20):
    """Mix sources with a short TTL; never let a blocked site break other sources."""
    query = query.strip()[:80]
    if not query:
        return []
    limit = max(1, min(int(limit), 50))
    cache_key = (query.lower(), limit)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached
    jobs = []
    # The caller-supplied ``search_cookpad`` callback is only trusted as an
    # official-API source when scraping is explicitly enabled; by default the
    # server-side implementation scrapes Cookpad, so it must be gated behind
    # the same feature flag as the built-in scrapers.
    if SCRAPING_ENABLED:
        jobs.append((search_cookpad, (query, min(limit, 12))))
    jobs.extend(((search_allrecipes, (query, min(limit, 8))),
                 (search_detik, (query, min(limit, 6)))))
    with ThreadPoolExecutor(max_workers=_MAX_CONCURRENT_SEARCHES) as pool:
        futures = [pool.submit(fn, *args) for fn, args in jobs]
        results = []
        for future in futures:
            try:
                results.append(future.result())
            except Exception as exc:
                sys.stderr.write(f"Sumber resep gagal: {exc}\n")
                results.append([])
    # Interleave rather than burying the smaller sources after 12 Cookpad cards.
    seen = set()
    cards = []
    for row in zip(*[source + [None] * max(0, limit - len(source)) for source in results]):
        for card in row:
            if not card or card["url"] in seen:
                continue
            # Validate every card's URL/thumbnail before it reaches the client.
            if not (_host_allowed(card.get("url", ""), _ALLOWED_RESULT_HOSTS) and _host_allowed(card.get("thumbnail", ""), _ALLOWED_THUMBNAIL_HOSTS)):
                continue
            seen.add(card["url"])
            cards.append(card)
            if len(cards) == limit:
                break
        if len(cards) == limit:
            break
    _evict_expired()
    _cache_put(cache_key, cards)
    return [dict(card) for card in cards]
