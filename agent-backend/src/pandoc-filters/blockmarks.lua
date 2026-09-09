-- Page map for the editor's page-break lines (Typst output only). Before
-- every top-level block — and once after the last — insert an invisible
-- Typst metadata marker that records, at layout time, the page and vertical
-- position where that block begins, plus a fingerprint of its text so the
-- webapp can match markers back to editor blocks. render.js reads the
-- markers with `typst eval 'query(<kuhn-block>)'` after compiling.
--
-- The markers are layout-neutral: metadata takes no space (verified: text
-- bounding boxes are byte-identical with and without them).
--
-- The fingerprint must match webapp/src/page-breaks.ts `blockKey`: the
-- block's plain text, lower-cased, ASCII letters and digits only, first 24.

local KEY_LEN = 24

local function block_key(block)
  local text = pandoc.utils.stringify(block):lower():gsub('[^a-z0-9]', '')
  return text:sub(1, KEY_LEN)
end

local function marker(i, key)
  return pandoc.RawBlock('typst', string.format(
    '#context [#metadata((i: %d, key: %s, page: here().page(), y: here().position().y.pt(), h: page.height.to-absolute().pt())) <kuhn-block>]',
    i, pandoc.json.encode(key)))
end

function Pandoc(doc)
  if not FORMAT:match('typst') then return nil end
  local out = {}
  for i, block in ipairs(doc.blocks) do
    table.insert(out, marker(i, block_key(block)))
    table.insert(out, block)
  end
  table.insert(out, marker(-1, ''))
  doc.blocks = out
  return doc
end
