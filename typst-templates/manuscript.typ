// @template manuscript
// Kuhn Typst template: journal manuscript for submission/review.
//
//   paper      US letter
//   margins    1 in on every side
//   font       Times New Roman 12 pt (Liberation Serif is the metric-compatible
//              stand-in baked into docker/typst; Nimbus Roman next)
//   spacing    double — what most journals ask for in a submitted draft
//   extras     continuous line numbers in the margin, page numbers, a
//              centred title block with authors and an abstract
//   headings   bold, unnumbered; the section titles most journals use
//
// Pandoc calls `conf` with the arguments its default Typst template passes
// (see typst-templates/default.typ); every parameter is accepted so
// front-matter overrides keep working.

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
  margin: (x: 1in, y: 1in),
  paper: "us-letter",
  lang: "en",
  region: "US",
  font: ("Liberation Serif", "Times New Roman", "Nimbus Roman", "Times"),
  fontsize: 12pt,
  mathfont: none,
  codefont: none,
  linestretch: 2,
  sectionnumbering: none,
  linkcolor: none,
  citecolor: none,
  filecolor: none,
  pagenumbering: "1",
  doc,
) = {
  set document(title: title, keywords: keywords)
  set document(
    author: authors.map(author => content-to-string(author.name)).join(", ", last: " & "),
  ) if authors != none and authors != ()
  set page(paper: paper, margin: margin, numbering: pagenumbering, columns: cols)

  // Word-like line pitch: ~1.15× the font size per "single" line; the glyph
  // box of a Times-metric face is ~1.15em, so leading carries the stretch.
  set par(justify: false, leading: (0.05em + (linestretch - 1) * 1.15em), spacing: 1.15em * linestretch, first-line-indent: 0.5in)
  set par.line(numbering: "1", numbering-scope: "document")
  set text(lang: lang, region: region, size: fontsize, font: font)
  show math.equation: set text(font: mathfont) if mathfont != none
  show raw: set text(font: codefont) if codefont != none

  set heading(numbering: sectionnumbering)
  show heading: set text(size: fontsize, weight: "bold")
  show heading: set block(above: 1em, below: 0.5em)
  show heading: set par.line(numbering: none)

  show link: set text(fill: rgb(content-to-string(linkcolor))) if linkcolor != none
  show ref: set text(fill: rgb(content-to-string(citecolor))) if citecolor != none

  if title != none {
    align(center, block(below: 1.5em)[
      #set par.line(numbering: none)
      #text(weight: "bold", size: fontsize * 1.15)[#title]
      #if subtitle != none { linebreak(); text(weight: "bold")[#subtitle] }
      #if authors != none and authors != () {
        parbreak()
        authors.map(author => [#author.name#if author.affiliation != "" and author.affiliation != [] [, #author.affiliation]]).join(", ", last: " and ")
      }
      #if date != none { parbreak(); date }
    ])
  }
  if abstract != none {
    block(below: 1.5em)[
      #set par.line(numbering: none)
      #text(weight: "bold")[#if abstract-title != none [#abstract-title] else [Abstract]]
      #parbreak()
      #abstract
    ]
  }
  doc
}
