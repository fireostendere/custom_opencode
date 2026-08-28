export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char])
}

const keywords = {
  javascript: new Set('const let var function return if else for while do switch case break continue class extends new async await try catch finally throw import export from default typeof instanceof in of this true false null undefined'.split(' ')),
  typescript: new Set('const let var function return if else for while do switch case break continue class extends new async await try catch finally throw import export from default typeof instanceof in of this true false null undefined interface type enum implements public private protected readonly abstract declare namespace as satisfies'.split(' ')),
  python: new Set('def return if elif else for while break continue class import from as try except finally raise with lambda yield async await in is not and or True False None pass global nonlocal'.split(' ')),
  bash: new Set('if then else elif fi for while do done case esac function in select until time coproc'.split(' ')),
  shell: new Set('if then else elif fi for while do done case esac function in select until time coproc'.split(' ')),
}

function normalizeLang(lang) {
  const value = (lang || '').toLowerCase().replace(/^language-/, '')
  if (value === 'js' || value === 'jsx') return 'javascript'
  if (value === 'ts' || value === 'tsx') return 'typescript'
  if (value === 'py') return 'python'
  if (value === 'sh' || value === 'zsh') return 'bash'
  return value
}

export function highlightCode(code, lang) {
  const language = normalizeLang(lang)
  const wordSet = keywords[language]
  if (!wordSet && language !== 'json') return escapeHtml(code)
  const source = String(code)
  const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|#[^\n]*|\/\/[^\n]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g
  let out = ''
  let last = 0
  for (const match of source.matchAll(pattern)) {
    out += escapeHtml(source.slice(last, match.index))
    const token = match[0]
    let cls = ''
    if (/^['"`]/.test(token)) cls = 'tok-str'
    else if (/^(#|\/\/)/.test(token)) cls = 'tok-com'
    else if (/^\d/.test(token)) cls = 'tok-num'
    else if (language === 'json' && /^(true|false|null)$/.test(token)) cls = 'tok-key'
    else if (wordSet?.has(token)) cls = 'tok-key'
    out += cls ? `<span class="${cls}">${escapeHtml(token)}</span>` : escapeHtml(token)
    last = match.index + token.length
  }
  out += escapeHtml(source.slice(last))
  return out
}

function renderInline(text) {
  const codes = []
  let value = String(text ?? '').replace(/`([^`\n]+)`/g, (_, code) => {
    const key = `\u0000CODE${codes.length}\u0000`
    codes.push(`<code class="inline">${escapeHtml(code)}</code>`)
    return key
  })
  value = escapeHtml(value)
  value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  value = value.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  value = value.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  value = value.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  codes.forEach((html, index) => { value = value.replace(`\u0000CODE${index}\u0000`, html) })
  return value
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^```([^\s`]*)\s*$/.exec(line)
    if (fence) {
      const lang = normalizeLang(fence[1])
      const code = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++])
      if (i < lines.length) i++
      const raw = code.join('\n')
      out.push(`<div class="code-block"><div class="code-head"><span>${escapeHtml(lang || 'code')}</span><button class="copy-code" type="button">Копировать</button></div><pre><code data-lang="${escapeHtml(lang)}">${highlightCode(raw, lang)}</code></pre></div>`)
      continue
    }
    if (!line.trim()) { i++; continue }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      i++; continue
    }
    if (i + 1 < lines.length && line.includes('|') && isTableSeparator(lines[i + 1])) {
      const headers = tableCells(line)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(tableCells(lines[i++]))
      out.push(`<table class="md-table"><thead><tr>${headers.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, idx) => `<td>${renderInline(row[idx] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      const quote = []
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''))
      out.push(`<blockquote>${quote.map(renderInline).join('<br>')}</blockquote>`)
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''))
      out.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''))
      out.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ol>`)
      continue
    }
    const paragraph = [line]
    i++
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^(#{1,3})\s+/.test(lines[i]) && !/^>\s?/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
      if (i + 1 < lines.length && lines[i].includes('|') && isTableSeparator(lines[i + 1])) break
      paragraph.push(lines[i++])
    }
    out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`)
  }
  return out.join('')
}
