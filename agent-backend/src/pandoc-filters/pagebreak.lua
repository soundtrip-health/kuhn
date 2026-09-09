-- Page breaks for Kuhn markdown. Pandoc parses a bare `\newpage` (or
-- `\pagebreak`) line as raw TeX and keeps it only for LaTeX output — Typst
-- (the PDF preview) and docx drop it silently. This filter rewrites the
-- marker into each target's native page break so one source produces the
-- same pagination everywhere. The HTML idiom
-- `<div style="page-break-after: always"></div>` is honoured too.
--
-- Mounted read-only into the pandoc sandbox by sandbox.js (pandocConvert).

local BLOCK = {
  typst = '#pagebreak()',
  openxml = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
  html = '<div style="page-break-after: always;"></div>',
}
local INLINE = {
  typst = '#pagebreak()',
  openxml = '<w:r><w:br w:type="page"/></w:r>',
  html = '<span style="page-break-after: always;"></span>',
}

local function target()
  if FORMAT:match('typst') then return 'typst' end
  if FORMAT:match('docx') then return 'openxml' end
  if FORMAT:match('html') or FORMAT:match('epub') then return 'html' end
  return nil -- latex/beamer keep the raw TeX; other writers get nothing useful
end

local function is_tex_marker(text)
  -- Lua patterns have no alternation; check each command explicitly.
  local t = text:gsub('^%s+', ''):gsub('%s+$', '')
  return t == '\\newpage' or t == '\\pagebreak' or t == '\\clearpage'
end

local function is_tex(format)
  return format == 'tex' or format == 'latex'
end

local function css_page_break(attr)
  local style = (attr.attributes and attr.attributes['style'] or ''):lower()
  for _, pat in ipairs({
    'page%-break%-after%s*:%s*always', 'page%-break%-before%s*:%s*always',
    'break%-after%s*:%s*page', 'break%-before%s*:%s*page',
  }) do
    if style:match(pat) then return true end
  end
  return false
end

local fmt = target()

function RawBlock(el)
  if not fmt or not is_tex(el.format) or not is_tex_marker(el.text) then return nil end
  return pandoc.RawBlock(fmt, BLOCK[fmt])
end

function RawInline(el)
  if not fmt or not is_tex(el.format) or not is_tex_marker(el.text) then return nil end
  return pandoc.RawInline(fmt, INLINE[fmt])
end

function Div(el)
  if not fmt or #el.content > 0 or not css_page_break(el.attr) then return nil end
  return pandoc.RawBlock(fmt, BLOCK[fmt])
end
