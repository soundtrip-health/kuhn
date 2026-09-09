# Interchange bundle fixture

The source tree of a Kuhn interchange bundle (`docs/specs/interchange-bundle.md`):
`manifest.json`, `references.json`, and `files/<workspace path>`. Zip this
directory's *contents* (not the directory) to get a bundle:

```bash
cd test-projects/interchange && zip -r ../../tmp/bundle.zip manifest.json references.json files
```

The backend tests build the zip in memory from this tree
(`agent-backend/src/routes/interchange.test.js`), and the token-free check
script pushes it to a running backend. The doc exercises citation groups,
a locator, a `[TODO: …]` marker, a doc-relative figure link, a GFM table,
and an email address that must not be mistaken for a citation.
