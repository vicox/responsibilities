#!/usr/bin/env python3
"""Static checks for the site. Standard library only: python3 tests/check.py"""

import hashlib
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://responsibilities.dev/"
PAGES = {"index.html": SITE, "impressum.html": SITE + "impressum.html"}  # page: canonical
README = "https://github.com/vicox/responsibilities#readme"  # the external links: the README
SIMULATION = "https://github.com/vicox/responsibilities/blob/main/docs/simulation.md"  # and the simulation
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}

failures = []


def check(ok, message):
    if not ok:
        failures.append(message)


class Page(HTMLParser):
    def __init__(self, name):
        super().__init__()
        self.name = name
        self.stack, self.ids, self.links, self.headings, self.meta = [], [], [], [], {}
        self.html_lang = self.title = self.canonical = None
        self.text_of = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag not in VOID:
            self.stack.append((tag, self.getpos()[0]))
        if "id" in a:
            self.ids.append(a["id"])
        if tag == "html":
            self.html_lang = a.get("lang")
        if tag == "meta":
            key = a.get("name") or a.get("property") or ("charset" if "charset" in a else None)
            if key:
                self.meta.setdefault(key, []).append(a.get("content", a.get("charset")))
        if tag == "link" and a.get("rel") == "canonical":
            self.canonical = a.get("href")
        for attr in ("href", "src"):
            if attr in a:
                self.links.append((tag, a.get("rel"), a[attr]))
        if re.fullmatch(r"h[1-6]", tag):
            self.headings.append(int(tag[1]))
        if tag == "title":
            self.text_of = "title"

    def handle_data(self, data):
        if self.text_of == "title":
            self.title = (self.title or "") + data

    def handle_endtag(self, tag):
        if tag == "title":
            self.text_of = None
        if tag in VOID:
            return
        if not self.stack or self.stack[-1][0] != tag:
            opened = self.stack[-1] if self.stack else None
            failures.append(f"{self.name}:{self.getpos()[0]}: </{tag}> does not close {opened}")
            return
        self.stack.pop()


def luminance(hex_color):
    rgb = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a, b):
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def parse(name):
    html = (ROOT / name).read_text(encoding="utf-8")
    page = Page(name)
    page.feed(html)
    page.close()
    return html, page


pages = {name: parse(name) for name in PAGES}
css = (ROOT / "styles.css").read_text(encoding="utf-8")

# The stylesheet URL carries a hash of styles.css. Pages serves it with max-age=600, so without the
# hash a browser or CDN can pair new HTML with an older stylesheet for up to ten minutes.
CSS_HREF = "styles.css?v=" + hashlib.sha256((ROOT / "styles.css").read_bytes()).hexdigest()[:8]
for name in PAGES:
    check(f'<link rel="stylesheet" href="{CSS_HREF}">' in pages[name][0],
          f"{name}: the stylesheet link must be {CSS_HREF} (update it whenever styles.css changes)")

for name, canonical in PAGES.items():
    html, page = pages[name]

    # Document structure
    check(html.startswith("<!doctype html>"), f"{name} must start with <!doctype html>")
    check(not page.stack, f"{name}: unclosed elements: {page.stack}")
    check(page.html_lang == "en", f"{name}: <html lang> must be en")
    check(len(page.ids) == len(set(page.ids)), f"{name}: duplicate ids")

    # SEO / meta
    check(page.meta.get("charset") == ["utf-8"], f"{name}: meta charset utf-8")
    check(page.meta.get("viewport") == ["width=device-width, initial-scale=1"], f"{name}: meta viewport")
    check(page.title and "responsibilities" in page.title.lower() and len(page.title) <= 70, f"{name}: title: {page.title!r}")
    description = (page.meta.get("description") or [""])[0]
    check(70 <= len(description) <= 200, f"{name}: meta description length {len(description)}")
    check(page.canonical == canonical, f"{name}: canonical must be {canonical}")

    # Headings: one h1, no skipped levels
    check(page.headings.count(1) == 1, f"{name}: exactly one h1")
    for prev, cur in zip(page.headings, page.headings[1:]):
        check(cur <= prev + 1, f"{name}: heading level jumps from h{prev} to h{cur}")

    # Every page links to the Impressum
    check(any(url == "impressum.html" for _, _, url in page.links), f"{name}: no link to impressum.html")

    # Links: local URLs are relative, exist and, with a fragment, point at an id that exists;
    # the only absolute URLs are mailto:, the page's own canonical, the README and the
    # simulation on GitHub.
    for tag, rel, url in page.links:
        if url.startswith("mailto:"):
            continue
        if re.match(r"^[a-z][a-z0-9+.-]*:", url, re.I) or url.startswith("//"):
            check((url == canonical and rel == "canonical") or (tag == "a" and url in (README, SIMULATION)),
                  f"{name}: unexpected absolute URL: {url}")
            continue
        path, _, fragment = url.partition("#")
        path = path.split("?")[0]
        check(not path.startswith("/"), f"{name}: root-relative URL breaks on a subpath: {url}")
        target = ROOT / (path or name)
        if target.is_dir():
            target = target / "index.html"
        check(target.exists(), f"{name}: missing local file: {url}")
        if fragment:
            linked = pages.get(target.relative_to(ROOT).as_posix())
            check(linked is not None and fragment in linked[1].ids, f"{name}: anchor {url} has no target")
    absolute = set(re.findall(r"https?://[^\s\"'<>)]+", html))
    allowed = {SITE, canonical, README, SIMULATION}
    check(absolute <= allowed, f"{name}: external references: {sorted(absolute - allowed)}")

# The concept page: Open Graph and required content
html, page = pages["index.html"]
for key in ("og:type", "og:site_name", "og:url", "og:title", "og:description", "twitter:card"):
    check(key in page.meta, f"index.html: missing meta {key}")
check(page.meta.get("og:url") == [SITE], f"index.html: og:url must be {SITE}")
# The hero, word for word and in order: the claim, the one line under it, then the CTAs and
# nothing else. The title, og:title and footers carry the claim; the description and
# og:description stand alone in a search result or a shared link, so they say a little more.
H1 = "Persistent Responsibilities for AI Agents"
SUBHEAD = ("Give AI agents something to own beyond a single task — "
           "with persistent context, evidence, and decisions across runs.")
TITLE = "Persistent Responsibilities for AI Agents — responsibilities.dev"
OG_TITLE = H1
DESCRIPTION = ("Give AI agents something to own beyond a single task: a lasting expectation, judged run after run, "
               "with persistent context, evidence and decisions. People stay accountable.")
hero = re.search(r'<section class="hero"[^>]*>(.*?)</section>', html, re.S)
HERO = (f'<div class="wrap"> <h1 id="hero-title">{H1}</h1> <p class="subhead">{SUBHEAD}</p> <p class="cta"> '
        f'<a class="button" href="{README}">Get started on GitHub</a> '
        '<a href="#how">See how it works <span aria-hidden="true">→</span></a> </p> </div>')
check(hero and re.sub(r"\s+", " ", hero.group(1)).strip() == HERO,
      f"index.html: the hero must be the H1 '{H1}', the one subhead '{SUBHEAD}' and the CTAs, and nothing else")
# Two CTAs, in order: the README on GitHub, then the explanation on this page
cta = re.search(r'<p class="cta">(.*?)</p>', html, re.S)
check(cta and re.findall(r"<a [^>]*>.*?</a>", cta.group(1), re.S) == [
    f'<a class="button" href="{README}">Get started on GitHub</a>',
    '<a href="#how">See how it works <span aria-hidden="true">→</span></a>',
], "index.html: the hero CTAs must be 'Get started on GitHub' (the README) and 'See how it works →' (#how)")
check(page.title == TITLE, f"index.html: title must be {TITLE!r}: {page.title!r}")
check(page.meta.get("og:title") == [OG_TITLE], f"index.html: og:title must be the claim: {OG_TITLE}")
check(page.meta.get("description") == [DESCRIPTION], "index.html: meta description is not verbatim")
check(page.meta.get("og:description") == [DESCRIPTION], "index.html: og:description must match the meta description")
for name in PAGES:
    check(f'<span class="brand-text">responsibilities.dev</span> · {H1}</p>' in pages[name][0],
          f"{name}: the footer must repeat the H1")

# Required content, word for word
for phrase in (
    '<p class="eyebrow">01 · How responsibilities work</p>',
    "Responsibilities stay. Matters come and go.",
    "Most agent work is a task: a prompt, a run, a result.",
    "A responsibility says what should be true and who answers for it.",
    "An agent can take it on, run after run.",
    "Actions can change the situation; fresh evidence shows what changed.",
    "Three responsibilities, three kinds of attention.",
    "<p>Each is something an agent can own: not a task to finish, but an expectation to keep true.</p>",
    "Delegate the work. Keep the responsibility.",
    "That gives you a basis for handing over more, step by step, and improving the agent as you go.",
    "<span>Observe deterministically.</span>",
    "<span>Judge probabilistically.</span>",
    "<span>Remember persistently.</span>",
    "<p>No fixed workflow, no dashboard to watch. In each run, the agent evaluates new evidence against the "
    "lasting expectation and everything known so far. Nothing has to run in between, and the next run "
    "needn’t be the same agent.</p>",
    '<p class="eyebrow">05 · Built for developers</p>',
    "Four functions. One responsibility lifecycle.",
    "pure functions over plain JSON: deterministic TypeScript with no runtime dependencies.",
    "Your host handles scheduling, models, tools and persistence.",
    "Optional: a person decides. A human override",
    "Closed is not success.",
    "Delegating the work does not automatically transfer accountability.",
    "An agent can own a responsibility day to day; a person still answers for it.",
    "Accountability can change hands through an explicit handover.",
    "Its view is only as current and complete as its observations.",
    "An agent acts only with the tools and permissions its host gives it",
):
    check(phrase in html, f"index.html: missing text: {phrase}")

# How responsibilities work: the four concepts, in order and word for word. A case is not
# defined by an Attention, and an Attention is a need to act, not one person's task.
CONCEPTS = [
    ("Responsibility", "What should stay true and who answers for it, written as expectations an agent can judge "
                       "against. Versioned: each recorded decision names the version it was made under."),
    ("Judgment", "A run judges new evidence against the expectation and what came before, and decides what follows. "
                 "Its decisions are kept with the evidence behind them."),
    ("Case", "One concrete situation, followed across runs until it is over: this customer, waiting for three days; "
             "this booking, still unpaid. A case can end without the expected outcome being achieved."),
    ("Attention", "A situation that requires action. The agent can act on it itself, or pass it to another agent "
                  "or a person. It can open early or late in a case, and close while the case goes on."),
]
concepts = re.search(r'<dl class="concepts">(.*?)</dl>', html, re.S)
cards = re.findall(r'<div class="card">\s*<dt>(.*?)</dt>\s*<dd>(.*?)</dd>\s*</div>', concepts.group(1), re.S) if concepts else []
check(concepts and re.sub(r'<div class="card">\s*<dt>.*?</dt>\s*<dd>.*?</dd>\s*</div>', "", concepts.group(1), flags=re.S).strip() == "",
      "index.html: the concepts list holds nothing but its cards")
check(cards == CONCEPTS, f"index.html: the concepts must be {', '.join(term for term, _ in CONCEPTS)}, word for word")
how = re.search(r'<section id="how"(.*?)</section>', html, re.S)
check(how and concepts and concepts.group(0) in how.group(1), "index.html: the concepts belong to How responsibilities work")

# The three examples, in order: each title, and the sentence that keeps evidence, the end of a
# case and its outcome apart
EXAMPLES = [
    ("Bookings are paid before the event.",
     "The matter is explained, but not over until the money arrives."),
    ("Customers waiting on us get an answer within two working days.",
     "That is evidence of an answer; a closed status alone is not. The wait is over, but the two-day target was missed."),
    ("A significant revenue decline is understood and owned.",
     "What ends this case, and what counts as a good outcome, depend on the expectations set beforehand."),
]
examples = re.search(r'<ol class="examples"[^>]*>(.*?)</ol>', html, re.S)
items = re.findall(r'<li class="card">(.*?)</li>', examples.group(1), re.S) if examples else []
check(len(items) == len(EXAMPLES), f"index.html: {len(items)} examples, expected {len(EXAMPLES)}")
for item, (title, sentence) in zip(items, EXAMPLES):
    check(f"<h3>{title}</h3>" in item, f"index.html: example title not verbatim: {title}")
    check(sentence in item, f"index.html: {title}: missing: {sentence}")
check("<details" not in html, "index.html: the examples have no disclosures")

# The delegation story: four steps, the responsibility's next run finding what the agent left,
# and the case closing on the recorded reply
story = re.search(r'<ol class="story"[^>]*>(.*?)</ol>', html, re.S)
check(story and story.group(1).count("<li>") == 4, "index.html: the delegation story must have four steps")
check(story and "On Thursday the responsibility’s next run finds the request still waiting in the support system, "
                "whatever the agent reported or didn’t. A case comes to your attention." in story.group(1),
      "index.html: the story's third step must be the responsibility's next run")
check(story and "The support system records your reply, and the case closes." in story.group(1),
      "index.html: the story must close its case on the recorded reply")

# Architecture: observe, judge, remember, each with its tag and its text, and no fourth step
FLOW = [
    ("Observe", "Evidence", "Signals run the same queries against the systems of record, every time. "
                            "What they find is kept as evidence, and relevant new evidence can start the next run."),
    ("Judge", "Decisions", "The agent evaluates new evidence against the expectation and its history, decides what "
                           "matters, and determines what to do next. It can act through its host’s tools, involve "
                           "another agent or a person, or decide that no action is needed."),
    ("Remember", "Context", "The responsibility, its cases, the evidence they rest on and every decision carry over, "
                            "so each judgment starts from what is already known."),
]
flow = re.search(r'<ol class="flow"[^>]*>(.*?)</ol>', html, re.S)
steps = re.findall(r"<li>(.*?)</li>", flow.group(1), re.S) if flow else []
check(len(steps) == len(FLOW), f"index.html: the flow has {len(steps)} steps, expected {len(FLOW)}")
for item, (title, tag, sentence) in zip(steps, FLOW):
    check(f"<h3>{title}</h3>" in item and f'<p class="tag">{tag}</p>' in item and f"<p>{sentence}</p>" in item,
          f"index.html: flow step {title} must be tagged {tag} and say: {sentence}")

# Built for developers: the four functions, in order, the simulation and the README
functions = re.search(r'<dl class="functions">(.*?)</dl>', html, re.S)
check(functions and re.findall(r"<dt><code>(\w+)</code></dt>", functions.group(1)) == ["view", "step", "command", "assess"],
      "index.html: the functions must be view, step, command, assess")
developers = re.search(r'<section id="developers"(.*?)</section>', html, re.S)
check(developers and f'href="{README}"' in developers.group(1), "index.html: Built for developers must link the README")
check(developers and f'href="{SIMULATION}"' in developers.group(1), "index.html: Built for developers must link the simulation")

order = [html.find(f'id="{section}"') for section in ("how", "examples", "delegation", "architecture", "developers", "accountability")]
check(-1 not in order and order == sorted(order),
      "index.html: sections must be ordered how, examples, delegation, architecture, developers, accountability")

# Retired wording stays gone: earlier examples and headings, and phrasings that claimed too much
for phrase in (
    "Work in progress for days", "Blocked dependencies", "Recurring customer complaints", "Jira",
    "Give AI agents responsibilities, not just", "Agent architecture",
    "Five things that should never be forgotten", "Tasks end. Responsibilities don’t.",
    "Agents are responsible.", "Alina", "It takes both", "come back to your attention",
    "Who answers for it doesn’t", "not surveillance", "changes the world", "stops falling",
    "Keep sight of what you", "The responsibility layer", "For human, agent, and automated work.",
    "each concrete matter that needs attention", "runs alongside the work",
):
    check(phrase not in html, f"index.html: superseded text: {phrase}")

# Wording: the site presents a concept, not an app, prototype or experiment, and does not name
# the internal implementation
for name in (*PAGES, "styles.css", "README.md"):
    text = (ROOT / name).read_text(encoding="utf-8")
    for word in ("rfj", "experiment", "prototype", "sketch", r"the app\b", "being tested"):
        check(not re.search(rf"\b{word}", text, re.I), f"{name}: unwanted wording: {word}")

# The Impressum: German, marked as such, with an address and a contact email
html, page = pages["impressum.html"]
for phrase in (
    '<div lang="de">',
    "Angaben gemäß § 5 DDG",
    "<address>",
    "Kontakt",
    'href="mailto:georg.schmidl@vicox.net"',
):
    check(phrase in html, f"impressum.html: missing text: {phrase}")

# CSS: nothing external, balanced braces, every var() defined, and WCAG AA contrast in both
# colour schemes
check(not re.search(r"https?://|@import", css), "styles.css must not load anything external")
check(css.count("{") == css.count("}"), "unbalanced braces in styles.css")
defined = set(re.findall(r"(--[\w-]+)\s*:", css))
for prop in set(re.findall(r"var\((--[\w-]+)\)", css)):
    check(prop in defined, f"undefined custom property {prop}")

light_block = re.search(r":root\s*{(.*?)}", css, re.S).group(1)
dark_block = re.search(r"prefers-color-scheme:\s*dark\)\s*{\s*:root\s*{(.*?)}", css, re.S).group(1)
light = dict(re.findall(r"(--[\w-]+):\s*(#[0-9a-fA-F]{6})", light_block))
themes = {"light": light, "dark": {**light, **dict(re.findall(r"(--[\w-]+):\s*(#[0-9a-fA-F]{6})", dark_block))}}
pairs = [
    ("--ink", "--bg"), ("--ink", "--surface"), ("--ink", "--code-bg"),
    ("--muted", "--bg"), ("--muted", "--surface"),
    ("--accent", "--bg"), ("--accent", "--surface"), ("--accent", "--accent-soft"), ("--ink", "--accent-soft"),
    ("--bg", "--ink"),  # skip link
    ("--bg", "--accent"),  # hero button
]
for theme, colours in themes.items():
    for fg, bg in pairs:
        ratio = contrast(colours[fg], colours[bg])
        check(ratio >= 4.5, f"{theme}: {fg} on {bg} contrast {ratio:.2f} < 4.5")

# Publishing
check((ROOT / "CNAME").read_text().strip() == "responsibilities.dev", "CNAME must be responsibilities.dev")
check((ROOT / ".nojekyll").exists(), ".nojekyll missing")

if failures:
    print("\n".join(f"FAIL {f}" for f in failures))
    sys.exit(1)
print("OK")
