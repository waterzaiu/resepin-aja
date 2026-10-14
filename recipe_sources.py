"""Additional public recipe indexes; return links and thumbnails, never copied recipes."""
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import re
import sys
import threading
import time
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

_TRANSLATE = {"ayam": "chicken", "telur": "egg", "kentang": "potato", "nasi": "rice", "mie": "noodles", "mi": "noodles", "ikan": "fish", "udang": "shrimp", "daging": "beef", "tomat": "tomato", "jamur": "mushroom", "wortel": "carrot", "bayam": "spinach", "tahu": "tofu", "kacang": "beans", "pisang": "banana", "keju": "cheese", "roti": "bread"}
_CACHE = {}
_LOCK = threading.Lock()


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
    words = [_TRANSLATE[w] for w in re.findall(r"[a-z]+", query.lower()) if w in _TRANSLATE]
    # Indonesian specialties without an English ingredient should not return unrelated Western recipes.
    if not words:
        return []
    parser = _Allrecipes()
    try:
        parser.feed(_fetch("https://www.allrecipes.com/search?q=" + quote(" ".join(words[:2]))))
        return parser.cards[:limit]
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"Allrecipes lookup gagal: {exc}\n")
        return []


def search_detik(query, limit=6):
    parser = _Detik()
    try:
        parser.feed(_fetch("https://food.detik.com/resep"))
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"detikFood lookup gagal: {exc}\n")
        return []
    words = [w for w in re.findall(r"[a-z]+", query.lower()) if len(w) > 2 and w not in {"resep", "masakan", "rumahan"}]
    if not words:
        return parser.cards[:limit]
    return [card for card in parser.cards if any(w in card["nama"].lower() for w in words)][:limit]


def mixed_recipes(query, search_cookpad, limit=20):
    """Mix sources with a short TTL; never let a blocked site break other sources."""
    query = query.strip()[:80]
    if not query:
        return []
    cache_key = (query.lower(), limit)
    with _LOCK:
        cached = _CACHE.get(cache_key)
        if cached and time.monotonic() - cached[0] < 600:
            return [dict(card) for card in cached[1]]
    jobs = ((search_cookpad, (query, min(limit, 12))),
            (search_allrecipes, (query, min(limit, 8))),
            (search_detik, (query, min(limit, 6))))
    with ThreadPoolExecutor(max_workers=3) as pool:
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
            seen.add(card["url"])
            cards.append(card)
            if len(cards) == limit:
                break
        if len(cards) == limit:
            break
    with _LOCK:
        _CACHE[cache_key] = (time.monotonic(), cards)
    return [dict(card) for card in cards]
