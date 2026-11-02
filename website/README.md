# responsibilities.dev

The one-page concept site for responsibilities.dev: *The responsibility layer.* Plain HTML and
CSS: no build step, framework, JavaScript or dependency.

| File | Purpose |
| --- | --- |
| `index.html` | The page, with its title, description, canonical and Open Graph tags |
| `impressum.html` | The Impressum (§ 5 DDG), linked from the footer of every page |
| `styles.css` | Layout and type, light and dark |
| `favicon.svg` | Icon |
| `CNAME` | Custom domain for GitHub Pages: `responsibilities.dev` |
| `.nojekyll` | Tells GitHub Pages to publish the files as they are, without Jekyll |
| `tests/check.py` | Static checks (Python standard library) |

Assets are linked with relative URLs (`styles.css`, `favicon.svg`, `#examples`,
`impressum.html`), so the pages work the same at `https://responsibilities.dev/`, under a
project path such as `https://<user>.github.io/responsibilities.dev/` and on a local server.
The only absolute URLs are each page's canonical link, the home page's `og:url`, its links to
the README on GitHub and the Impressum's `mailto:` contact.

Both pages link the stylesheet as `styles.css?v=<hash>`, the first eight hex digits of the
SHA-256 of `styles.css`. GitHub Pages lets browsers and its CDN cache files for ten minutes, so
without it new HTML can arrive with the previous stylesheet. After changing `styles.css`, run
the checks: they print the link to use.

## Preview and test

    python3 -m http.server 8000     # then open http://localhost:8000/
    python3 tests/check.py          # prints OK or the failed checks

The checks cover, on both pages, well-formed markup, one `h1` and no skipped heading levels,
the meta tags, a link to the Impressum, a footer that
repeats the claim, and that every link resolves (anchors on the other page included) and
nothing external is loaded; plus the home page's key content (the hero word for word: claim,
subhead and lede in order, and its two calls to action; the title with the short claim, and the
description and Open Graph tags with the full positioning; the three examples and their key
sentences; the four steps of the delegation story; the three steps of *Architecture*, each with
its tag and text; the four functions and the README link in *Built for developers*; the order
of the sections), wording that was retired and stays gone, a list of words the site does not
use, the Impressum's required parts, the `CNAME`, and WCAG AA contrast of the colour pairs in
both colour schemes.

## Deploy on GitHub Pages

The site is published from the root of `main`.

1. In the repository: **Settings → Pages → Build and deployment**: Source **Deploy from a
   branch**, branch `main`, folder `/ (root)`.
2. Under **Custom domain** enter `responsibilities.dev`. It matches the `CNAME` file; if GitHub
   commits its own `CNAME` there, the content is the same. GitHub recommends verifying the
   domain for the account first, to prevent takeovers.
3. At the DNS provider:
   - apex `responsibilities.dev`: `A` records `185.199.108.153`, `185.199.109.153`,
     `185.199.110.153`, `185.199.111.153`, and `AAAA` records `2606:50c0:8000::153`,
     `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`;
   - `www.responsibilities.dev`: `CNAME` to `vicox.github.io`.

   With both in place, GitHub Pages redirects `www.responsibilities.dev` to
   `responsibilities.dev`.
4. Select **Enforce HTTPS** once it is offered (this can take up to 24 hours). `.dev` is on
   the browsers' HSTS preload list, so the site only loads over HTTPS: it is reachable once
   GitHub has issued the certificate.
