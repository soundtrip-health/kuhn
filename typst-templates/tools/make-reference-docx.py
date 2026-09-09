#!/usr/bin/env python3
"""Build the Word reference documents that pair with the Typst templates.

Pandoc's docx writer takes page geometry, styles, headers and footers from a
"reference" .docx — the same rules the Typst template applies to the PDF, so a
Word export paginates like the preview. Word has no text-based template
format, so these are generated from Pandoc's stock reference.docx by editing
its XML, and the generated files are checked in next to catalog.json.

    python3 typst-templates/tools/make-reference-docx.py [--pandoc-ref reference.docx]

Without --pandoc-ref the stock file is pulled from the pandoc/core docker
image (`pandoc --print-default-data-file reference.docx`). Re-run after
changing a SPEC below or bumping pandoc.
"""

import argparse
import io
import re
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent  # typst-templates/

# Measurements in twentieths of a point (twips): 1 in = 1440, 1 pt = 20.
# Font sizes are half-points: 11 pt = 22.
SPECS = {
    'nih-grant': dict(
        font='Arial', size_half_pt=22,
        # Word "single" spacing = line 240 (1.0 lines); 6 pt after a paragraph.
        line=240, after=120, first_line_indent=0,
        margins=dict(top=720, right=720, bottom=720, left=720, header=360, footer=360),
        line_numbers=False, page_numbers=False,
        heading_space_before=240, heading_space_after=60,
    ),
    'manuscript': dict(
        font='Times New Roman', size_half_pt=24,
        line=480, after=0, first_line_indent=720,
        margins=dict(top=1440, right=1440, bottom=1440, left=1440, header=720, footer=720),
        line_numbers=True, page_numbers=True,
        heading_space_before=240, heading_space_after=0,
    ),
}

LETTER = '<w:pgSz w:w="12240" w:h="15840"/>'
R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
FOOTER_REL_ID = 'rIdKuhnFooter'

FOOTER_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    '<w:p><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="center"/></w:pPr>'
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
    '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
    '<w:r><w:t>1</w:t></w:r>'
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    '</w:p></w:ftr>'
)


def stock_reference(path):
    if path:
        return Path(path).read_bytes()
    return subprocess.run(
        ['docker', 'run', '--rm', 'pandoc/core:latest', '--print-default-data-file', 'reference.docx'],
        check=True, capture_output=True,
    ).stdout


def edit_styles(xml, spec):
    font = spec['font']
    fonts = f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:cs="{font}" w:eastAsia="{font}"/>'
    sz = f'<w:sz w:val="{spec["size_half_pt"]}"/><w:szCs w:val="{spec["size_half_pt"]}"/>'

    # Document defaults: one face, one size, one line pitch for everything.
    defaults = re.search(r'<w:docDefaults>.*?</w:docDefaults>', xml, re.S).group(0)
    new_defaults = re.sub(r'<w:rFonts[^>]*/>', fonts, defaults)
    new_defaults = re.sub(r'<w:sz w:val="\d+"\s*/>', sz.split('><')[0] + '>', new_defaults)
    new_defaults = re.sub(r'<w:szCs w:val="\d+"\s*/>', '<' + sz.split('><')[1], new_defaults)
    new_defaults = re.sub(
        r'<w:pPr>\s*<w:spacing[^>]*/>\s*</w:pPr>',
        f'<w:pPr><w:spacing w:after="{spec["after"]}" w:line="{spec["line"]}" w:lineRule="auto"/></w:pPr>',
        new_defaults,
    )
    xml = xml.replace(defaults, new_defaults)

    # Every named style inherits the defaults: strip per-style faces, colours
    # and sizes (Pandoc's headings are theme fonts in blue, larger).
    def clean_style(m):
        s = m.group(0)
        s = re.sub(r'<w:rFonts[^>]*/>', '', s)
        s = re.sub(r'<w:color[^>]*/>', '', s)
        s = re.sub(r'<w:sz(?:Cs)? w:val="\d+"\s*/>', '', s)
        s = re.sub(r'<w:spacing w:after="\d+" w:line="\d+" w:lineRule="auto"\s*/>', '', s)  # Title's own pitch
        return s
    xml = re.sub(r'<w:style [^>]*>.*?</w:style>', clean_style, xml, flags=re.S)

    # Headings: bold, body size, tight spacing. Title: bold, centred.
    def restyle(style_id, ppr_extra, rpr_extra):
        nonlocal xml
        m = re.search(r'<w:style [^>]*w:styleId="%s".*?</w:style>' % style_id, xml, re.S)
        if not m:
            return
        s = m.group(0)
        s = re.sub(r'<w:spacing w:before="\d+" w:after="\d+"\s*/>', ppr_extra, s)
        if '<w:rPr>' in s:
            s = re.sub(r'<w:rPr>', '<w:rPr>' + rpr_extra, s, count=1)
        else:
            s = s.replace('</w:style>', f'<w:rPr>{rpr_extra}</w:rPr></w:style>')
        xml = xml.replace(m.group(0), s)

    hspace = f'<w:spacing w:before="{spec["heading_space_before"]}" w:after="{spec["heading_space_after"]}"/>'
    for level in range(1, 7):
        restyle(f'Heading{level}', hspace, '<w:b/>')
    restyle('Title', '<w:spacing w:before="0" w:after="120"/>', '<w:b/>')

    # Body paragraphs: no extra space before; optional first-line indent.
    body_ppr = f'<w:spacing w:before="0" w:after="{spec["after"]}"/>'
    if spec['first_line_indent']:
        body_ppr += f'<w:ind w:firstLine="{spec["first_line_indent"]}"/>'
    restyle('BodyText', body_ppr, '')
    return xml


def edit_document(xml, spec):
    m = spec['margins']
    sect = [
        LETTER,
        f'<w:pgMar w:top="{m["top"]}" w:right="{m["right"]}" w:bottom="{m["bottom"]}" '
        f'w:left="{m["left"]}" w:header="{m["header"]}" w:footer="{m["footer"]}" w:gutter="0"/>',
    ]
    if spec['line_numbers']:
        sect.append('<w:lnNumType w:countBy="1" w:restart="continuous"/>')
    if spec['page_numbers']:
        sect.insert(0, f'<w:footerReference w:type="default" r:id="{FOOTER_REL_ID}"/>')
        if 'xmlns:r=' not in xml:
            xml = xml.replace('<w:document ', f'<w:document xmlns:r="{R_NS}" ', 1)
    footnote_pr = '<w:footnotePr><w:numRestart w:val="eachSect"/></w:footnotePr>'
    new_sect = '<w:sectPr>' + ''.join(sect) + footnote_pr + '</w:sectPr>'
    return re.sub(r'<w:sectPr>.*?</w:sectPr>', new_sect, xml, count=1, flags=re.S)


def build(stock, spec):
    src = zipfile.ZipFile(io.BytesIO(stock))
    out_buf = io.BytesIO()
    with zipfile.ZipFile(out_buf, 'w', zipfile.ZIP_DEFLATED) as out:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == 'word/styles.xml':
                data = edit_styles(data.decode('utf-8'), spec).encode('utf-8')
            elif item.filename == 'word/document.xml':
                data = edit_document(data.decode('utf-8'), spec).encode('utf-8')
            elif item.filename == 'word/_rels/document.xml.rels' and spec['page_numbers']:
                rel = (f'<Relationship Id="{FOOTER_REL_ID}" Type="{R_NS}/footer" Target="footer1.xml"/>')
                data = data.decode('utf-8').replace('</Relationships>', rel + '</Relationships>').encode('utf-8')
            elif item.filename == '[Content_Types].xml' and spec['page_numbers']:
                override = ('<Override PartName="/word/footer1.xml" '
                            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>')
                data = data.decode('utf-8').replace('</Types>', override + '</Types>').encode('utf-8')
            out.writestr(item, data)
        if spec['page_numbers']:
            out.writestr('word/footer1.xml', FOOTER_XML)
    return out_buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pandoc-ref', help="pandoc's stock reference.docx (default: from the docker image)")
    ap.add_argument('--out-dir', default=str(HERE))
    args = ap.parse_args()
    stock = stock_reference(args.pandoc_ref)
    for name, spec in SPECS.items():
        target = Path(args.out_dir) / f'{name}.docx'
        target.write_bytes(build(stock, spec))
        print(f'wrote {target} ({target.stat().st_size} bytes)')


if __name__ == '__main__':
    sys.exit(main())
