# kuhn/typst — Typst renderer with template fonts

The Kuhn-built Typst image: `ghcr.io/typst/typst` plus the free, metric-compatible
font families the page-layout templates in `typst-templates/` name.

```bash
docker build -t kuhn/typst:latest docker/typst
```

| Template asks for | Face in the image |
|---|---|
| Arial / Helvetica | Liberation Sans, Nimbus Sans |
| Times New Roman | Liberation Serif, Nimbus Roman |
| Courier New | Liberation Mono, Nimbus Mono PS |
| Calibri / Cambria | Carlito / Caladea |
| Palatino | P052 |

Why it matters: an NIH attachment is "Arial 11 pt, 0.5 in margins" and its page
limit is checked against exactly that. The stock image has no sans face with Arial's
metrics, so the PDF preview would paginate differently from Word — and from the NIH
system's own check. The sandbox runs with `--network none`, so fonts cannot be fetched
at render time; they are baked in.

Override the image with `SANDBOX_TYPST_IMAGE`. The stock `ghcr.io/typst/typst:latest`
still renders every document (Typst warns about unknown families and falls back to
Libertinus), so a deploy that never uses page-limited templates can skip the build.
