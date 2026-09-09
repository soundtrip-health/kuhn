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
-- Headings also carry their level and text, and the end marker carries the
-- document's `page_limits:` front matter (section title → max pages), so
-- render.js can measure each budgeted section and the editor can badge it.
--
-- The fingerprint must match webapp/src/page-breaks.ts `blockKey`: the
-- block's plain text, lower-cased, ASCII letters and digits only, first 24.

local KEY_LEN = 24

local function block_key(block)
  local text = pandoc.utils.stringify(block):lower():gsub('[^a-z0-9]', '')
  return text:sub(1, KEY_LEN)
end

-- Typst string literals share JSON's escaping for everything we emit.
local function str(s) return pandoc.json.encode(s) end

local function marker(i, key, extra)
  return pandoc.RawBlock('typst', string.format(
    '#context [#metadata((i: %d, key: %s, page: here().page(), y: here().position().y.pt(), h: page.height.to-absolute().pt()%s)) <kuhn-block>]',
    i, str(key), extra or ''))
end

local function heading_fields(block)
  if block.t ~= 'Header' then return '' end
  return string.format(', level: %d, text: %s', block.level, str(pandoc.utils.stringify(block)))
end

-- `page_limits:` front matter as a Typst dictionary literal: (:) when absent.
local function limits_field(meta)
  local limits = meta.page_limits
  if type(limits) ~= 'table' then return ', limits: (:)' end
  local parts = {}
  for title, value in pairs(limits) do
    local n = tonumber(pandoc.utils.stringify(value))
    if n and n > 0 then table.insert(parts, string.format('%s: %s', str(title), tostring(n))) end
  end
  if #parts == 0 then return ', limits: (:)' end
  table.sort(parts)
  return ', limits: (' .. table.concat(parts, ', ') .. ')'
end

function Pandoc(doc)
  if not FORMAT:match('typst') then return nil end
  local out = {}
  for i, block in ipairs(doc.blocks) do
    table.insert(out, marker(i, block_key(block), heading_fields(block)))
    table.insert(out, block)
  end
  table.insert(out, marker(-1, '', limits_field(doc.meta)))
  doc.blocks = out
  return doc
end
