# kuhn/marp

`marpteam/marp-cli` + LibreOffice Impress, so `--pptx-editable` (STH-61)
works inside the no-network sandbox. Build:

```bash
docker build -t kuhn/marp:latest docker/marp
```

Override the image with `SANDBOX_MARP_IMAGE`. Deploys that keep the stock
`marpteam/marp-cli` image still work: editable pptx export falls back to
marp's default slides-as-images pptx.
