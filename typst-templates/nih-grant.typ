// @template nih-grant
// Kuhn Typst template: NIH grant attachment (SF424 R&R Application Guide
// formatting rules — Specific Aims, Research Strategy, and the other
// page-limited attachments).
//
//   paper      US letter
//   margins    0.5 in on every side (the NIH minimum)
//   font       Arial 11 pt (Liberation Sans is the metric-compatible stand-in
//              baked into docker/typst; Helvetica/Nimbus Sans next)
//   spacing    single, Word-like line pitch — a draft that fits on one page
//              here fits on one page in Word too
//   headings   bold, unnumbered, the same size as body text
//   numbering  none, always — the NIH assembly system adds page numbers
//
// Pandoc calls `conf` with the arguments its default Typst template passes
// (see `pandoc --print-default-data-file templates/template.typst`); every
// parameter is accepted so front-matter overrides (fontsize, margin, …)
// keep working. Values not given fall back to the NIH rules above.

#let content-to-string(content) = {
  if content.has("text") { content.text }
  else if content.has("children") { content.children.map(content-to-string).join("") }
  else if content.has("body") { content-to-string(content.body) }
  else if content == [ ] { " " }
}

#let conf(
  title: none,
  subtitle: none,
  authors: (),
  keywords: (),
  date: none,
  abstract-title: none,
  abstract: none,
  thanks: none,
  cols: 1,
  margin: (x: 0.5in, y: 0.5in),
  paper: "us-letter",
  lang: "en",
  region: "US",
  font: ("Liberation Sans", "Arial", "Helvetica", "Nimbus Sans"),
  fontsize: 11pt,
  mathfont: none,
  codefont: none,
  linestretch: 1,
  sectionnumbering: none,
  linkcolor: none,
  citecolor: none,
  filecolor: none,
  pagenumbering: none,
  doc,
) = {
  set document(title: title, keywords: keywords)
  set document(
    author: authors.map(author => content-to-string(author.name)).join(", ", last: " & "),
  ) if authors != none and authors != ()
  // NIH's assembly system stamps page numbers on the whole application, so
  // attachments carry none — whatever Pandoc passes for pagenumbering.
  set page(paper: paper, margin: margin, numbering: none, columns: cols)

  // Word's "single" spacing sets the line pitch to ~1.15× the font size;
  // Typst's leading is the gap between glyph boxes (~1.12em for Arial), so
  // a small leading reproduces it. linestretch scales the pitch.
  set par(justify: false, leading: (0.25em + (linestretch - 1) * 1.15em), spacing: 0.65em)
  set text(lang: lang, region: region, size: fontsize, font: font)
  show math.equation: set text(font: mathfont) if mathfont != none
  show raw: set text(font: codefont) if codefont != none

  set heading(numbering: sectionnumbering)
  show heading: set text(size: fontsize, weight: "bold")
  show heading: set block(above: 0.9em, below: 0.5em)

  show link: set text(fill: rgb(content-to-string(linkcolor))) if linkcolor != none
  show ref: set text(fill: rgb(content-to-string(citecolor))) if citecolor != none

  // Compact lists and tables — attachments are dense by design.
  set list(spacing: 0.5em)
  set enum(spacing: 0.5em)
  set table(inset: 4pt)

  if title != none {
    align(center, block(below: 0.8em)[
      #text(weight: "bold", size: fontsize)[#title]
      #if subtitle != none { linebreak(); text(weight: "bold")[#subtitle] }
    ])
  }
  doc
}
