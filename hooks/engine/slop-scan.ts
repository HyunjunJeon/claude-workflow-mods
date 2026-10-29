// The deterministic half of the anti-slop skill (skills/anti-slop/SKILL.md): the patterns a regular expression can find
// in the lines one Edit or Write added. register.ts runs it after every such call, in the main conversation and in node
// workers, and hands the hits to the model as context. It costs no model call and only reports; the model fixes or names
// the exemption. What needs judgment (a comment that restates the code, a guard for a state that cannot occur, readability)
// stays with the skill. Every rule here favours precision over recall: a false hit costs the model's attention on every edit.

export type SlopHit = { line: number; pattern: string; text: string; fix: string }

// rb is Ruby. brace is every other language with braces and // comments (Kotlin, C#, Swift, Scala, Dart, C, C++, PHP):
// it gets only the rules that hold in any such language. A language with rules of its own gets its own family.
type Family = 'ts' | 'js' | 'py' | 'go' | 'rs' | 'rb' | 'java' | 'brace'

type Scan = { raw: string; code: string; lines: readonly string[]; starts: readonly number[] }

type Rule = {
  pattern: string
  in: readonly Family[]
  // code: matched with string contents and comments blanked out; raw: matched against the text as written.
  view: 'code' | 'raw'
  regex: RegExp
  fix: string
  keep?: (match: RegExpExecArray, scan: Scan, line: number) => boolean
}

// Shown in the note: more hits than this are counted, not listed.
export const MAX_NOTED_HITS = 8
// A file past either limit is minified or generated, not written by hand, and some rules are polynomial in line length
// with no regex timeout in JavaScript, so it is not scanned.
export const MAX_SCAN_CHARS = 200_000
export const MAX_SCAN_LINE = 2_000

const BRACE: Family = 'brace'
const EXTENSIONS: Record<string, readonly Family[]> = {
  ts: ['ts', 'js'], tsx: ['ts', 'js'], mts: ['ts', 'js'], cts: ['ts', 'js'],
  js: ['js'], jsx: ['js'], mjs: ['js'], cjs: ['js'],
  py: ['py'], go: ['go'], rs: ['rs'], rb: ['rb'],
  java: ['java'], kt: [BRACE], kts: [BRACE], cs: [BRACE], swift: [BRACE], scala: [BRACE], dart: [BRACE],
  c: [BRACE], h: [BRACE], cc: [BRACE], cpp: [BRACE], hpp: [BRACE], php: [BRACE],
}
const SLASH: readonly Family[] = ['ts', 'js', 'go', 'rs', 'java', BRACE]
const HASH: readonly Family[] = ['py', 'rb']
const JS: readonly Family[] = ['ts', 'js']

const TOP = 'use the type the code handles, and parse outside data into it once at the boundary'
const DICT = 'name the fields, or use a finite-key Record<"a" | "b", T>'
const REASON = 'name the invariant in a `SAFETY:` comment directly above, or parse instead'
const SUPPRESS = 'name the rule and the reason (`@ts-expect-error -- why`, `# type: ignore[code]`), or fix the code'
const SWALLOW = 'let the error propagate or handle it; if ignoring it is the decision, say why in a comment inside the block'
const RETHROW = 'remove the handler; the error propagates unchanged without it'
const BOOLEAN = 'return the condition itself (negated if the branches are swapped)'
const PASS_THROUGH = 'return the expression directly; the variable name adds nothing'
const TODO = 'implement it now, or report the requested behavior as not done'
const DEBUG = 'remove the debugging statement'
const COMMENTED = 'delete it; version control keeps the old code'
const GROW = 'mutate the accumulator the reduce started with and return it; each copy re-copies everything gathered so far'
const PLAIN_NAMES = 'result|res|ret|retval|output|out|value|val|data|response|resp|tmp|temp'

export function familiesOf(path: string): readonly Family[] {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase()
  return (extension && EXTENSIONS[extension]) || []
}

const differ = (match: RegExpExecArray) => match[1] !== match[2]

const balanced = (text: string) => (text.match(/\{/g) ?? []).length === (text.match(/\}/g) ?? []).length

// A directive counts only inside a comment, not in a string or a regular expression that mentions it.
const inComment = (match: RegExpExecArray, scan: Scan) => /\/\/|\/\*|^[ \t]*\*/.test(scan.raw.slice(scan.raw.lastIndexOf('\n', match.index - 1) + 1, match.index))

// The code view blanks comments, so a match there can span one; the raw text tells whether it did.
const uncommented = (match: RegExpExecArray, scan: Scan) => !/\/\/|\/\*|#/.test(scan.raw.slice(match.index, match.index + match[0].length))

function lineText(scan: Scan, line: number): string {
  return scan.lines[line - 1] ?? ''
}

// A SAFETY: comment on the line itself or in the comment block directly above it.
function reasoned(scan: Scan, line: number): boolean {
  if (/\bSAFETY:/.test(lineText(scan, line))) return true
  for (let above = line - 1; above >= 1; above -= 1) {
    const text = lineText(scan, above).trim()
    if (!/^(?:\/\/|\/\*|\*|#)/.test(text)) return false
    if (/\bSAFETY:/.test(text)) return true
  }
  return false
}

// The next token after the match is not this word: a rethrow-only handler before another handler narrows what that one catches.
function notBefore(word: string) {
  return (match: RegExpExecArray, scan: Scan) => !new RegExp(`^\\s*${word}\\b`).test(scan.code.slice(match.index + match[0].length))
}

function lineBefore(scan: Scan, match: RegExpExecArray): string {
  return scan.code.slice(scan.code.lastIndexOf('\n', match.index - 1) + 1, match.index)
}

const FUNCTION_LINE = /\bfunction\b|=>|^[ \t]*(?:(?:public|private|protected|static|async|export|declare|abstract|override|readonly|get|set)[ \t]+)*[\w$]+[ \t]*(?:<[^>\n]*>)?[ \t]*\(/

// A comment on the line or directly above it: Java's @SuppressWarnings has no field for the reason.
function explained(scan: Scan, line: number): boolean {
  return /\/\/|\/\*/.test(lineText(scan, line)) || /^(?:\/\/|\/\*|\*)/.test(lineText(scan, line - 1).trim())
}

// A TS parameter typed any or object. unknown is left to the skill: in hand-parsing code the unknown parameter is
// usually the boundary parser's own input, which the scan cannot tell apart (measured: 30 of 36 hits on this
// repository's 10.5k lines were parsers). Exempt: a catch binding and the parameter a type predicate narrows.
function contractParameter(match: RegExpExecArray, scan: Scan, line: number): boolean {
  const text = lineText(scan, line)
  if (!FUNCTION_LINE.test(text) || /\bcatch[ \t]*$/.test(lineBefore(scan, match))) return false
  const narrowed = /\)[ \t]*:[ \t]*(?:asserts[ \t]+)?(\w+)(?:[ \t]+is\b|[ \t]*(?:\{|;|$))/.exec(text)?.[1]
  return narrowed !== match[1]
}

// An iterator pipeline (values(), keys(), entries(), Iterator.from) is lazy, so filter then map makes no throwaway array.
function eagerChain(match: RegExpExecArray, scan: Scan): boolean {
  if (match[1] === match[2]) return false
  const start = Math.max(0, match.index - 300)
  const lead = scan.code.slice(start, match.index)
  const statement = lead.slice(Math.max(lead.lastIndexOf(';'), lead.lastIndexOf('\n\n')) + 1)
  return !/\.(?:values|keys|entries)\(\)|\bIterator\.from\(/.test(statement)
}

const RULES: readonly Rule[] = [
  // Dead weight, any language.
  { pattern: 'todo-stub', in: SLASH, view: 'raw', regex: /(?:\/\/|\/\*)[^\n]*?\b(?:TODO|FIXME|XXX)\b/g, fix: TODO },
  { pattern: 'todo-stub', in: HASH, view: 'raw', regex: /#[^\n]*?\b(?:TODO|FIXME|XXX)\b/g, fix: TODO },
  { pattern: 'debug-leftover', in: JS, view: 'code', regex: /^[ \t]*debugger\b/gm, fix: DEBUG },
  { pattern: 'debug-leftover', in: ['py'], view: 'code', regex: /\b(?:breakpoint\(\)|pdb\.set_trace\(\))/g, fix: DEBUG },
  { pattern: 'debug-leftover', in: ['rb'], view: 'code', regex: /\bbinding\.(?:pry|irb)\b/g, fix: DEBUG },
  { pattern: 'debug-leftover', in: ['rs'], view: 'code', regex: /\bdbg!\(/g, fix: DEBUG },
  { pattern: 'debug-leftover', in: ['java'], view: 'code', regex: /\.printStackTrace\([ \t]*\)/g, fix: 'log it through the project logger with context, or let it propagate' },
  {
    pattern: 'commented-out-code', in: SLASH, view: 'raw', fix: COMMENTED,
    regex: /^[ \t]*\/\/[ \t]*(?:(?:return|const|let|var|if|for|while|import)\b[^\n]*|[\w$.[\]]+[ \t]*(?:=[^=\n][^\n]*|\([^\n]*\)))[;{][ \t]*$/gm,
  },
  {
    pattern: 'commented-out-code', in: ['py'], view: 'raw', fix: COMMENTED,
    regex: /^[ \t]*#[ \t]*(?:return(?:[ \t]+[\w.]+(?:\([^\n]*\))?)?|import [\w.]+|from [\w.]+ import [\w., ]+|[\w.[\]]+[ \t]*=[ \t]*(?:[\w.]+\([^\n]*\)|[\d"'[{][^\n]*)|[\w.]+\([^\n]*\))[ \t]*$/gm,
  },
  // A comment in the handler is the documented decision to ignore the error, so it exempts the block.
  { pattern: 'swallowed-error', in: [...JS, 'java', BRACE], view: 'code', regex: /\bcatch\b[ \t]*(?:\([^)\n]*\))?[ \t]*\{\s*\}/g, keep: uncommented, fix: SWALLOW },
  { pattern: 'swallowed-error', in: ['py'], view: 'code', regex: /\bexcept\b[^:\n]*:[ \t]*(?:\n[ \t]*)?pass\b/g, keep: uncommented, fix: SWALLOW },
  { pattern: 'swallowed-error', in: ['go'], view: 'code', regex: /\bif[ \t]+err[ \t]*!=[ \t]*nil[ \t]*\{\s*\}/g, keep: uncommented, fix: SWALLOW },
  { pattern: 'swallowed-error', in: ['rb'], view: 'code', regex: /^[ \t]*rescue\b[^\n]*\n[ \t]*end\b/gm, keep: uncommented, fix: SWALLOW },
  {
    pattern: 'rethrow-only-catch', in: [...JS, 'java', BRACE], view: 'code', fix: RETHROW, keep: notBefore('catch'),
    regex: /\bcatch[ \t]*\([ \t]*(?:[\w.|]+[ \t]+)?(\w+)[ \t]*(?::[^)\n]*)?\)[ \t]*\{\s*throw(?:[ \t]+\1)?[ \t]*;?\s*\}/g,
  },
  {
    pattern: 'rethrow-only-catch', in: ['py'], view: 'code', fix: RETHROW,
    regex: /\bexcept\b[^:\n]*?(?:[ \t]as[ \t]+(\w+))?[ \t]*:[ \t]*\n[ \t]*raise(?:[ \t]+(\w+))?[ \t]*(?=\n|$)/g,
    keep: (match, scan) => (match[2] === undefined || match[2] === match[1]) && notBefore('except')(match, scan),
  },
  // `T extends U ? true : false` is a conditional type, not a value.
  {
    pattern: 'boolean-ceremony', in: SLASH, view: 'code', fix: BOOLEAN, regex: /\?[ \t]*(true|false)[ \t]*:[ \t]*(true|false)\b/g,
    keep: (match, scan) => differ(match) && !/\bextends\b[^?]*$/.test(lineBefore(scan, match)),
  },
  // Before any else, the if's own braces must balance: a `}` without a `{` closes an enclosing loop, so the
  // `return false` after it is not the if's other branch.
  {
    pattern: 'boolean-ceremony', in: SLASH, view: 'code', fix: BOOLEAN,
    keep: match => differ(match) && balanced(match[0].split(/\belse\b/)[0] ?? ''),
    regex: /\bif\b[ \t]*(?:\((?:[^()\n]|\([^()\n]*\))*\)|[^{;\n()]+?)[ \t]*\{?\s*return[ \t]+(true|false)[ \t]*;?\s*\}?\s*(?:else\b[ \t]*\{?\s*)?return[ \t]+(true|false)\b/g,
  },
  { pattern: 'boolean-ceremony', in: ['py'], view: 'code', fix: BOOLEAN, keep: differ, regex: /\b(True|False)[ \t]+if\b[^\n]+?\belse[ \t]+(True|False)\b/g },
  {
    pattern: 'boolean-ceremony', in: ['py'], view: 'code', fix: BOOLEAN, keep: differ,
    regex: /\bif\b[^\n]+:[ \t]*\n[ \t]*return[ \t]+(True|False)[ \t]*\n(?:[ \t]*else[ \t]*:[ \t]*\n)?[ \t]*return[ \t]+(True|False)\b/g,
  },
  // Only generic names: a specific name can document what the value is. An annotated binding is a type check, so it stays.
  {
    pattern: 'pass-through-variable', in: JS, view: 'code', fix: PASS_THROUGH,
    regex: new RegExp(`\\b(?:const|let|var)[ \\t]+(${PLAIN_NAMES})[ \\t]*=[ \\t]*[^;\\n]+;?[ \\t]*\\n[ \\t]*return[ \\t]+\\1[ \\t]*;?[ \\t]*$`, 'gm'),
  },
  {
    pattern: 'pass-through-variable', in: ['java'], view: 'code', fix: PASS_THROUGH,
    regex: new RegExp(`(?:\\bfinal[ \\t]+)?\\b(?:var|[A-Z][\\w.]*(?:<[^;\\n=]*>)?(?:\\[\\])*)[ \\t]+(${PLAIN_NAMES})[ \\t]*=[ \\t]*[^;\\n]+;[ \\t]*\\n[ \\t]*return[ \\t]+\\1[ \\t]*;`, 'g'),
  },
  {
    pattern: 'pass-through-variable', in: ['go'], view: 'code', fix: PASS_THROUGH,
    regex: new RegExp(`\\b(${PLAIN_NAMES})[ \\t]*:=[ \\t]*[^\\n]+\\n[ \\t]*return[ \\t]+\\1[ \\t]*$`, 'gm'),
  },
  {
    pattern: 'pass-through-variable', in: ['py'], view: 'code', fix: PASS_THROUGH,
    regex: new RegExp(`^([ \\t]*)(${PLAIN_NAMES})[ \\t]*=[ \\t]*[^\\n]+\\n\\1return[ \\t]+\\2[ \\t]*$`, 'gm'),
  },

  // Evidence the code throws away.
  { pattern: 'chained-assertion', in: ['ts'], view: 'code', regex: /\bas[ \t]+(?:unknown|any|object|never)[ \t]+as\b(?![ \t]+const\b)/g, fix: 'parse the value or fix the source type; a double cast forges evidence the compiler refused' },
  { pattern: 'top-type', in: ['ts'], view: 'code', regex: /\bas[ \t]+any\b(?![ \t]+as\b)/g, fix: TOP },
  { pattern: 'top-type', in: ['ts'], view: 'code', regex: /\)[ \t]*:[ \t]*(?:Promise(?:Like)?<[ \t]*any[ \t]*>|any)[ \t]*(?:\{|=>)/g, fix: TOP },
  { pattern: 'top-type', in: ['ts'], view: 'code', regex: /^[ \t]*(?:export[ \t]+)?type[ \t]+\w+(?:<[^>\n]*>)?[ \t]*=[ \t]*(?:unknown|any)[ \t]*;?[ \t]*$/gm, fix: TOP },
  { pattern: 'top-type', in: ['ts'], view: 'code', regex: /[(,][ \t]*(\w+)[ \t]*\??[ \t]*:[ \t]*(?:any|object)[ \t]*(?=[,)=])/g, keep: contractParameter, fix: TOP },
  { pattern: 'top-type', in: ['py'], view: 'code', regex: /->[ \t]*Any\b|:[ \t]*Any[ \t]*(?=[,)=\n]|$)|\b(?:dict|Dict|Mapping)\[[ \t]*str[ \t]*,[ \t]*Any[ \t]*\]/g, fix: TOP },
  { pattern: 'top-type', in: ['go'], view: 'code', regex: /\bmap\[string\](?:interface\{\}|any)\b|\bfunc\b[^\n{]*[(,][ \t]*\w+[ \t]+(?:interface\{\}|any)[ \t]*[,)]/g, fix: TOP },
  // equals(Object) is the signature Java requires for an override.
  {
    pattern: 'top-type', in: ['java'], view: 'code', fix: TOP,
    regex: /[(,][ \t]*(?:final[ \t]+)?Object[ \t]+\w+[ \t]*(?=[,)])|\b(?:public|protected|private|static)[ \t]+(?:[\w<>]+[ \t]+)*Object[ \t]+\w+[ \t]*\(/g,
    keep: (match, scan) => !/\bequals[ \t]*$/.test(lineBefore(scan, match)),
  },
  { pattern: 'open-dictionary', in: ['java'], view: 'code', regex: /\bMap<[ \t]*String[ \t]*,[ \t]*(?:Object|\?)[ \t]*>/g, fix: 'give the data a record or class with named fields' },
  {
    pattern: 'open-dictionary', in: ['ts'], view: 'code', fix: DICT,
    regex: /\bRecord<[ \t]*string[ \t]*,[ \t]*(?:unknown|any|object|\{[ \t]*\})[ \t]*>/g,
    keep: (match, scan) => !/\b(?:extends|is)[ \t]*$/.test(lineBefore(scan, match)),
  },
  { pattern: 'open-dictionary', in: ['ts'], view: 'code', regex: /\{[ \t]*\[[ \t]*\w+[ \t]*:[ \t]*string[ \t]*\][ \t]*:[ \t]*(?:unknown|any|object)[ \t]*;?[ \t]*\}/g, fix: DICT },
  // `as` after an expression and before a type; import and export renames are not assertions.
  {
    pattern: 'unreasoned-assertion', in: ['ts'], view: 'code', fix: REASON,
    regex: /(?<=[\w$)\]}>'"`][ \t]*)\bas[ \t]+(?!const\b)(?=[A-Z_${[(]|(?:string|number|boolean|bigint|symbol|object|unknown|any|never|undefined|null|readonly|keyof|typeof)\b)/g,
    keep: (match, scan, line) => !/^[ \t]*(?:import|export)\b[^=]*\bas\b/.test(lineText(scan, line)) && !reasoned(scan, line),
  },
  { pattern: 'unreasoned-assertion', in: ['py'], view: 'code', regex: /(?<![\w.])(?:typing\.)?cast\(/g, keep: (match, scan, line) => !reasoned(scan, line), fix: REASON },
  {
    pattern: 'unreasoned-assertion', in: ['go'], view: 'code', fix: REASON, regex: /\.\([ \t]*\*?[\w.]+[ \t]*\)/g,
    keep: (match, scan, line) => !/\btype\b/.test(match[0]) && !/,[ \t]*\w+[ \t]*:?=/.test(lineText(scan, line)) && !reasoned(scan, line),
  },
  // A reference cast: a parenthesised type name before an operand, not a call (foo(Bar)) and not a condition (if (READY) run()).
  {
    pattern: 'unreasoned-assertion', in: ['java'], view: 'code', fix: REASON,
    regex: /(?<![\w$])\([ \t]*[A-Z][\w.]*(?:<[^()\n]*>)?(?:\[\])*[ \t]*\)[ \t]*(?=[\w$(])/g,
    keep: (match, scan, line) => !/\b(?:if|while|for|switch|catch|synchronized)[ \t]*$/.test(lineBefore(scan, match)) && !reasoned(scan, line),
  },
  { pattern: 'unreasoned-assertion', in: ['rs'], view: 'code', regex: /\bunsafe[ \t]*\{/g, keep: (match, scan, line) => !reasoned(scan, line), fix: REASON },
  { pattern: 'suppression-without-reason', in: ['ts'], view: 'raw', regex: /@ts-ignore\b|@ts-expect-error[ \t]*(?:\*\/)?[ \t]*$/gm, keep: inComment, fix: SUPPRESS },
  { pattern: 'suppression-without-reason', in: JS, view: 'raw', regex: /\beslint-disable(?:-next-line|-line)?\b(?![^\n]*--)/g, keep: inComment, fix: SUPPRESS },
  { pattern: 'suppression-without-reason', in: ['py'], view: 'raw', regex: /#[ \t]*(?:type|pyright):[ \t]*ignore\b(?![ \t]*\[)|#[ \t]*noqa\b(?![ \t]*:)/g, fix: SUPPRESS },
  { pattern: 'suppression-without-reason', in: ['java'], view: 'code', regex: /@SuppressWarnings\b/g, keep: (match, scan, line) => !explained(scan, line), fix: 'say why in a comment on the line or directly above, or fix the code' },
  { pattern: 'suppression-without-reason', in: ['go'], view: 'raw', regex: /\/\/[ \t]*nolint\b(?!:)/g, fix: SUPPRESS },
  { pattern: 'reflection', in: JS, view: 'code', regex: /\bReflect\.(?:get|apply)[ \t]*\(/g, fix: 'use property access or a direct call; parse outside data first' },
  { pattern: 'reflection', in: ['py'], view: 'raw', regex: /\bgetattr\([ \t]*[\w.]+[ \t]*,[ \t]*(['"])[A-Za-z_]\w*\1[ \t]*\)/g, fix: 'access the attribute directly' },

  // JavaScript and TypeScript forms.
  { pattern: 'two-pass-filter-map', in: JS, view: 'code', regex: /\.(filter|map)\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*\.(filter|map)\(/g, keep: eagerChain, fix: 'make one pass: flatMap, a loop that pushes, or an iterator pipeline where the runtime has one' },
  {
    pattern: 'growing-copy', in: JS, view: 'code', fix: GROW,
    regex: /\.reduce(?:Right)?\([ \t]*(?:async[ \t]*)?\(?[ \t]*(\w+)[^)=\n]*\)?[ \t]*=>\s*\(?\s*(?:\{\s*\.\.\.\1\b|\[\s*\.\.\.\1\b|Object\.assign\(\s*\{\s*\}\s*,\s*\1\b|\1\.(?:concat|slice|toSpliced|toSorted|toReversed|with)\(|Array\.from\(\s*\1\s*\))/g,
  },
  {
    pattern: 'growing-copy', in: JS, view: 'code', fix: GROW,
    regex: /\.reduce(?:Right)?\([ \t]*\(?[ \t]*(\w+)[^)=\n]*\)?[ \t]*=>[ \t]*\{[^{}]*?return[ \t]+(?:\{\s*\.\.\.\1\b|\[\s*\.\.\.\1\b|Object\.assign\(\s*\{\s*\}\s*,\s*\1\b|\1\.concat\()/g,
  },
  {
    pattern: 'conditional-empty-spread', in: JS, view: 'code', fix: 'assign the field directly when the consumer accepts undefined; otherwise set it in a plain if after building the object',
    regex: /\.\.\.[ \t]*\((?:[^()?\n]|\([^()\n]*\))*\?[ \t]*(?:\{[^{}\n]*\}|[\w$.]+)[ \t]*:[ \t]*\{[ \t]*\}[ \t]*\)|\.\.\.[ \t]*\((?:[^()?\n]|\([^()\n]*\))*\?[ \t]*\{[ \t]*\}[ \t]*:/g,
  },
  { pattern: 'module-mock', in: ['java'], view: 'code', regex: /\b(?:Mockito\.)?mock(?:Static|Construction)[ \t]*\(|\bPowerMockito\./g, fix: 'inject the dependency and pass a fake; static mocking rewires classes behind the code' },
  { pattern: 'module-mock', in: JS, view: 'code', regex: /\b(?:vi|jest)\.(?:mock|doMock|unstable_mockModule)[ \t]*\(/g, fix: 'pass the dependency in and hand the test a fake at that seam' },
]

// The repository rule files whose `anti-slop allow:` lines the scan honours. A project's settings cannot carry plugin
// options (measured 2026-10-12: pluginConfigs in a project's .claude/settings.json were ignored, a --settings file was
// read), so a repository documents its exceptions where its other rules live.
export const RULE_FILES = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md']

// The pattern ids a rule file allows, from lines such as `anti-slop allow: open-dictionary, two-pass-filter-map`.
export function allowedPatterns(text: string): string[] {
  return [...text.matchAll(/^[ \t>*-]*anti-slop allow:[ \t]*([^\n]*)$/gim)].flatMap(match => (match[1] ?? '').split(/[\s,`]+/).filter(id => /^[a-z]+(?:-[a-z]+)*$/.test(id)))
}

// The lines of `after` that `before` does not account for, 1-based. Lines compare trimmed, so re-indenting is no change,
// and each line of `before` accounts for one equal line of `after`. Blank lines are never added.
export function addedLines(before: string, after: string): Set<number> {
  const old = new Map<string, number>()
  for (const line of before.split('\n')) old.set(line.trim(), (old.get(line.trim()) ?? 0) + 1)
  const added = new Set<number>()
  after.split('\n').forEach((line, index) => {
    const key = line.trim()
    const count = old.get(key) ?? 0
    if (count > 0) old.set(key, count - 1)
    else if (key) added.add(index + 1)
  })
  return added
}

// The text with string contents and comments replaced by spaces, newlines and offsets kept, so a code pattern cannot
// match inside a string or a comment. String delimiters stay. A Python triple-quoted string is one string.
export function codeView(text: string, families: readonly Family[]): string {
  const slash = families.some(family => SLASH.includes(family))
  const hash = families.some(family => HASH.includes(family))
  const blank = (part: string) => part.replace(/[^\n]/g, ' ')
  let out = ''
  let at = 0
  while (at < text.length) {
    const char = text[at]!
    const next = text[at + 1]
    const lineEnd = text.indexOf('\n', at) < 0 ? text.length : text.indexOf('\n', at)
    if ((slash && char === '/' && next === '/') || (hash && char === '#')) {
      out += blank(text.slice(at, lineEnd))
      at = lineEnd
    } else if (slash && char === '/' && next === '*') {
      const close = text.indexOf('*/', at + 2)
      const end = close < 0 ? text.length : close + 2
      out += blank(text.slice(at, end))
      at = end
    } else if (char === '"' || char === "'" || char === '`') {
      const delimiter = hash && text.startsWith(char.repeat(3), at) ? char.repeat(3) : char
      const multiline = delimiter.length === 3 || char === '`'
      let end = at + delimiter.length
      while (end < text.length && !text.startsWith(delimiter, end) && (multiline || text[end] !== '\n')) end += text[end] === '\\' ? 2 : 1
      const closed = text.startsWith(delimiter, end)
      const stop = Math.min(text.length, closed ? end + delimiter.length : end)
      out += delimiter + blank(text.slice(at + delimiter.length, closed ? end : stop)) + (closed ? delimiter : '')
      at = stop
    } else {
      out += char
      at += 1
    }
  }
  return out
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1)
  return starts
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if ((starts[middle] ?? 0) <= offset) low = middle
    else high = middle - 1
  }
  return low + 1
}

type TestCall = {
  readonly key: string
  readonly start: number
  readonly end: number
  readonly skipped: boolean
  readonly focused: boolean
  readonly body: string
  readonly bodyStart: number
}

// Delimiters in strings and comments are already blanked. No parser dependency or evaluation of test code.
function closing(code: string, start: number, open: string, close: string): number {
  let depth = 0
  for (let at = start; at < code.length; at += 1) {
    if (code[at] === open) depth += 1
    if (code[at] === close && --depth === 0) return at
  }
  return -1
}

// Deliberately narrow: literal titles and inline block callbacks on statement lines. Aliases, dynamic titles,
// parameterized tests and arbitrary control flow need review, not a heuristic warning after every edit.
function testCalls(scan: Scan): TestCall[] {
  const calls: TestCall[] = []
  const header = /^[ \t]*(test|it|describe|xtest|xit|xdescribe|fit|fdescribe)(\s*\.\s*(?:skip|todo|only)|\s*\.\s*(?:skipIf\s*\(\s*true\s*\)|runIf\s*\(\s*false\s*\)))?\s*\(\s*(['"])[^'"\n]*\3/gm
  for (const match of scan.code.matchAll(header)) {
    const start = match.index + match[0].search(/\S/)
    const titleEnd = match.index + match[0].length
    const titleOpen = match.index + match[0].indexOf(match[3] ?? '')
    const rest = scan.code.slice(titleEnd)
    const callback = /^\s*,\s*(?:\{([^{}]*)\}\s*,\s*)?(?:async\s+)?(?:(?:\([^()]*\)|[\w$]+)\s*=>|function(?:\s+[\w$]+)?\s*\([^()]*\))\s*\{/.exec(rest)
    const skipped = /^x/.test(match[1] ?? '') || /skip|todo|runIf/.test(match[2] ?? '') || /\bskip\s*:\s*true\b/.test(callback?.[1] ?? '')
    const focused = /^f/.test(match[1] ?? '') || /only/.test(match[2] ?? '')
    if (!callback && !/^\s*\)/.test(rest)) continue
    const bodyStart = callback ? titleEnd + callback[0].length : titleEnd
    const bodyEnd = callback ? closing(scan.code, bodyStart - 1, '{', '}') : titleEnd
    if (bodyEnd < 0 || (callback && !/^\s*\)/.test(scan.code.slice(bodyEnd + 1)))) continue
    calls.push({
      key: `${(match[1] ?? '').replace(/^[xf](?=it$|describe$|test$)/, '')}:${scan.raw.slice(titleOpen, titleEnd)}`,
      start, end: bodyEnd, skipped, focused,
      body: callback ? scan.code.slice(bodyStart, bodyEnd) : '',
      bodyStart,
    })
  }
  return calls
}

type TestAssertion = {
  readonly text: string
  readonly start: number
  readonly tautology: boolean
  readonly identity?: string
  readonly expected?: string
}

// Raw offsets preserve string values without making comments or string contents executable syntax.
const EXPECTED_LITERAL = /^(?:true|false|null|undefined|-?\d+(?:\.\d+)?|'[^'\\\n]*'|"[^"\\\n]*")$/
const ADVISORY = 'advisory candidate only: check the explicit requirement and verification evidence; a valid requirement change or equivalent verification can justify this edit'

function testAssertions(body: string, raw = body): TestAssertion[] {
  const assertions: TestAssertion[] = []
  for (const match of body.matchAll(/^[ \t]*(?:(?:await|return)[ \t]+)?expect\s*\(/gm)) {
    const open = match.index + match[0].length - 1
    const end = closing(body, open, '(', ')')
    if (end < 0) continue
    const matcher = /^\s*((?:\.\s*(?:not|resolves|rejects)\s*)*)\.\s*(to[A-Z]\w*)\s*\(/.exec(body.slice(end + 1))
    if (!matcher) continue
    const argumentStart = end + 1 + matcher[0].length
    const argumentEnd = closing(body, argumentStart - 1, '(', ')')
    if (argumentEnd < 0) continue
    const actual = body.slice(open + 1, end).trim()
    const expected = body.slice(argumentStart, argumentEnd).trim()
    const literal = /^(?:true|false|null|undefined|-?\d+(?:\.\d+)?)$/.test(actual)
    const tautology = literal && !matcher[1] && (
      (['toBe', 'toEqual', 'toStrictEqual'].includes(matcher[2] ?? '') && actual === expected) ||
      (matcher[2] === 'toBeTruthy' && actual === 'true' && !expected) ||
      (matcher[2] === 'toBeFalsy' && actual === 'false' && !expected)
    )
    const rawExpected = raw.slice(argumentStart, argumentEnd).trim()
    const rawActual = raw.slice(open + 1, end).trim()
    assertions.push({
      text: body.slice(match.index, argumentEnd + 1).replace(/\s+/g, ''), start: match.index, tautology,
      ...(rawActual && !/\/\/|\/\*/.test(raw.slice(open, argumentEnd + 1))
        ? { identity: `${rawActual}:${matcher[0].replace(/\s+/g, '')}` } : {}),
      ...(EXPECTED_LITERAL.test(rawExpected) ? {
          expected: /^['"]/.test(rawExpected) ? `string:${rawExpected.slice(1, -1)}`
            : /^-?\d/.test(rawExpected) ? `number:${Object.is(Number(rawExpected), -0) ? '-0' : Number(rawExpected)}` : rawExpected,
        } : {}),
    })
  }
  for (const match of body.matchAll(/^[ \t]*(?:return[ \t]+)?assert(?:\.(ok|equal|strictEqual|deepEqual|deepStrictEqual))?\s*\(/gm)) {
    const open = match.index + match[0].length - 1
    const end = closing(body, open, '(', ')')
    if (end < 0) continue
    const argumentsText = body.slice(open + 1, end).trim()
    const equality = /^(true|false|null|undefined|-?\d+(?:\.\d+)?)\s*,\s*(true|false|null|undefined|-?\d+(?:\.\d+)?)$/.exec(argumentsText)
    const tautology = match[1] && match[1] !== 'ok'
      ? equality !== null && equality[1] === equality[2]
      : argumentsText === 'true'
    assertions.push({ text: body.slice(match.index, end + 1).replace(/\s+/g, ''), start: match.index, tautology })
  }
  return assertions
}

function testWeakening(before: Scan, after: Scan, added: ReadonlySet<number>, skip: ReadonlySet<string>): SlopHit[] {
  const old = testCalls(before)
  const current = testCalls(after)
  const hits: SlopHit[] = []
  for (const call of current) {
    // Duplicate titles cannot identify a replacement precisely.
    const previous = old.filter(candidate => candidate.key === call.key)
    const prior = previous.length === 1 && current.filter(candidate => candidate.key === call.key).length === 1 ? previous[0] : undefined
    const line = lineAt(after.starts, call.start)
    const touched = [...added].some(addedLine => addedLine >= line && addedLine <= lineAt(after.starts, call.end))
    const report = (pattern: string, at: number, fix = 'restore the executable test and its meaningful assertions, or name the documented exemption') => {
      if (skip.has(pattern)) return
      const hitLine = lineAt(after.starts, at)
      hits.push({ line: hitLine, pattern, text: lineText(after, hitLine).trim().slice(0, 120), fix })
    }
    const kind = call.key.slice(0, call.key.indexOf(':') + 1)
    const addedSkip = current.filter(candidate => candidate.skipped && candidate.key.startsWith(kind)).length >
      old.filter(candidate => candidate.skipped && candidate.key.startsWith(kind)).length
    if (call.skipped && touched && !prior?.skipped && addedSkip) report('test-skip', call.start)
    // A focused test silently narrows what runs; only a focus this edit adds counts.
    const addedFocus = current.filter(candidate => candidate.focused && candidate.key.startsWith(kind)).length >
      old.filter(candidate => candidate.focused && candidate.key.startsWith(kind)).length
    if (call.focused && touched && !prior?.focused && addedFocus) report('test-focus', call.start, 'remove the focus (.only, fit, fdescribe) so the whole suite runs, or name the documented exemption')
    if (!prior || call.skipped || prior.skipped || /^describe:/.test(call.key)) continue
    const previousAssertions = testAssertions(prior.body, before.raw.slice(prior.bodyStart, prior.end))
    const assertions = testAssertions(call.body, after.raw.slice(call.bodyStart, call.end))
    // Local aliases/shadows and duplicate assertion identities cannot identify a changed contract safely.
    const shadowed = /(?:\b(?:const|let|var|function|class|import)\s+(?:expect|test|it)\b|\b(?:const|let|var)\s*[\[{][^;=\n]*\b(?:expect|test|it)\b|\bas\s+(?:expect|test|it)\b|\b(?:expect|test|it)\s*=>|\([^()\n]*\b(?:expect|test|it)\b[^()\n]*\)\s*(?:=>|\{))/
    const sameAssertions = previousAssertions.every(assertion => assertion.identity
      ? assertions.some(next => next.identity === assertion.identity)
      : assertions.some(next => next.text === assertion.text)) &&
      assertions.every(assertion => assertion.identity
        ? previousAssertions.some(previous => previous.identity === assertion.identity)
        : previousAssertions.some(previous => previous.text === assertion.text))
    const oldScope = old.filter(candidate => candidate.start < prior.start && candidate.end > prior.end).map(candidate => candidate.key)
    const scope = current.filter(candidate => candidate.start < call.start && candidate.end > call.end).map(candidate => candidate.key)
    if (sameAssertions && JSON.stringify(oldScope) === JSON.stringify(scope) && !shadowed.test(before.code) && !shadowed.test(after.code)) {
      for (const assertion of assertions) {
        if (!assertion.identity || assertion.tautology) continue
        const candidates = previousAssertions.filter(oldAssertion => oldAssertion.identity === assertion.identity)
        if (candidates.length !== 1 || assertions.filter(next => next.identity === assertion.identity).length !== 1) continue
        const candidate = candidates[0]
        const at = call.bodyStart + assertion.start
        if (candidate?.expected !== undefined && assertion.expected !== undefined && candidate.expected !== assertion.expected &&
          added.has(lineAt(after.starts, at)) && !skip.has('test-expectation-change')) {
          const hitLine = lineAt(after.starts, at)
          hits.push({ line: hitLine, pattern: 'test-expectation-change', text: lineText(after, hitLine).trim().slice(0, 120), fix: ADVISORY })
        }
      }
    }
    if (previousAssertions.some(assertion => !assertion.tautology) && prior.body.trim() && (
      !call.body.trim() || (/^\s*return[ \t]*(?:;|(?=\n|$))/.test(call.body) && !/^\s*return\b/.test(prior.body))
    )) report('test-disabled', call.start)
    // Count reductions are not evidence. Require a removed meaningful assertion in this same named test
    // and a newly written assertion whose literal inputs prove it cannot fail.
    if (previousAssertions.some(assertion => !assertion.tautology && !assertions.some(next => next.text === assertion.text))) {
      for (const assertion of assertions) {
        const at = call.bodyStart + assertion.start
        if (assertion.tautology && added.has(lineAt(after.starts, at)) && !previousAssertions.some(oldAssertion => oldAssertion.text === assertion.text)) report('test-tautology', at)
      }
    }
  }
  return hits
}

// An unconditional pytest/unittest skip decorator added to a Python test file. A skipif/skipIf condition is dynamic and no hit.
// The code view blanks strings and comments, so a decorator quoted in either never matches.
const PY_TEST_FILE = /(?:^|[/\\])(?:test_[^/\\]*|[^/\\]*_test)\.py$/i
const PY_SKIP_DECORATOR = /^[ \t]*@(?:pytest\.mark\.skip|unittest\.skip)(?:[ \t]*\([^()]*\))?[ \t]*$/gm

function pythonSkips(scan: Scan, added: ReadonlySet<number>): SlopHit[] {
  const hits: SlopHit[] = []
  for (const match of scan.code.matchAll(PY_SKIP_DECORATOR)) {
    const line = lineAt(scan.starts, match.index + match[0].search(/\S/))
    if (added.has(line)) hits.push({ line, pattern: 'test-skip', text: lineText(scan, line).trim().slice(0, 120), fix: 'restore the executable test, or use a skipif with a real condition' })
  }
  return hits
}

// Only direct, single-return named functions: no inferred SDK calls, data mentioning fetch, or file-wide counts.
function requirementSubstitution(before: Scan, after: Scan, added: ReadonlySet<number>, request: string): SlopHit[] {
  if (request.length > MAX_SCAN_CHARS) return []
  const realApi = /(?:^|[.!?\n]\s*)\s*(?:TASK:\s*)?(?:please\s+)?(?:implement|connect|integrate|use|build|add)\b[^.!?\n]*\b(?:real|live)\s+(?:\w+\s+){0,2}api\b/i.test(request) ||
    /(?:실제|실)\s*API(?:를|와|에|로)?[^.!?\n]*(?:연동|연결|호출|사용|구현)/i.test(request)
  if (/\b(?:docs?|documentation|example|demo|tutorial)\b/i.test(request) ||
    /(?:문서|예제|데모|튜토리얼)/.test(request) ||
    /(?:실제\s*API|실\s*API|API|연동|호출)[^.!?\n]*(?:하지\s*(?:마|않)|안\s*(?:하|해|할)|필요\s*없|불필요|대신\s*(?:mock|가짜|모의)|제외)|(?:가짜|모의|mock)[^.!?\n]*(?:사용|쓰|대체)/i.test(request) ||
    /(?:\b(?:no|not|never|without|avoid|optional)\b|n't\b)[^.!?\n]*\b(?:real|live|api|integration|calls)\b|\b(?:api|integration)\b[^.!?\n]*\b(?:optional|not required)\b|\b(?:use|using|with|return)\s+(?:a\s+)?(?:fake|mock|stub)\b/i.test(request) ||
    !realApi) return []
  const shadow = /(?:\b(?:const|let|var|function|class)\s+fetch\b|\b(?:const|let|var)\s*[\[{][^;=\n]*\bfetch\b|\bimport\b[^\n]*\bfetch\b|\bas\s+fetch\b|\bfetch\s*=>|\([^()\n]*\bfetch\b[^()\n]*\)\s*(?:=>|\{))/
  if (shadow.test(before.code) || shadow.test(after.code)) return []
  const functions = (scan: Scan) => {
    const calls: { readonly header: string; readonly body: string; readonly code: string; readonly start: number }[] = []
    for (const match of scan.code.matchAll(/^[ \t]*(?:export\s+)?(?:async\s+)?function\s+[\w$]+\s*\([^(){}\n]*\)\s*(?::[^{}\n]+)?\s*\{/gm)) {
      // A function inside a test, mock factory or other scope is not a production entry point.
      if (!balanced(scan.code.slice(0, match.index))) continue
      const start = match.index + match[0].length
      const end = closing(scan.code, start - 1, '{', '}')
      if (end < 0) continue
      calls.push({ header: scan.raw.slice(match.index, start).trim(), body: scan.raw.slice(start, end).trim(), code: scan.code.slice(start, end).trim(), start })
    }
    return calls
  }
  const old = functions(before)
  const current = functions(after)
  const scalar = String.raw`(?:true|false|null|-?\d+(?:\.\d+)?|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\[\s*\])`
  const property = `(?:[\\w$]+|'[^'\\n]*'|"[^"\\n]*")\\s*:\\s*${scalar}`
  const fixed = new RegExp(`^(?:${scalar}|\\{\\s*(?:${property}(?:\\s*,\\s*${property})*\\s*,?)?\\s*\\})$`)
  const hits: SlopHit[] = []
  for (const call of current) {
    const previous = old.filter(candidate => candidate.header === call.header)
    const prior = previous.length === 1 && current.filter(candidate => candidate.header === call.header).length === 1 ? previous[0] : undefined
    if (!prior || !/^return\s+(?:await\s+)?fetch\s*\(/.test(prior.code)) continue
    const open = prior.code.indexOf('(', prior.code.indexOf('fetch'))
    const end = closing(prior.code, open, '(', ')')
    if (end < 0 || !/^\s*;?$/.test(prior.code.slice(end + 1))) continue
    const returned = /^return\s+([\s\S]*?);?$/.exec(call.body)?.[1]?.trim()
    if (!returned) continue
    const value = /^(?:Promise\.resolve|Response\.json)\(([\s\S]*)\)$/.exec(returned)?.[1]?.trim() ?? returned
    if (!fixed.test(value)) continue
    const line = lineAt(after.starts, call.start)
    if (![...added].some(at => at >= line && at <= lineAt(after.starts, call.start + call.body.length))) continue
    hits.push({ line, pattern: 'requirement-substitution', text: lineText(after, line).trim().slice(0, 120), fix: ADVISORY })
  }
  return hits
}

// The pattern hits among the lines `after` adds to `before`, one per line and pattern, in line order. A file whose
// extension names no known language yields none. `skip` holds pattern ids the user turned off.
export function scanSlop(path: string, before: string, after: string, skip: ReadonlySet<string> = new Set(), request = ''): SlopHit[] {
  const families = familiesOf(path)
  if (families.length === 0 || after.length > MAX_SCAN_CHARS || after.split('\n').some(line => line.length > MAX_SCAN_LINE)) return []
  const added = addedLines(before, after)
  const testFile = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path)
  if (added.size === 0 && !testFile) return []
  const scan: Scan = { raw: after, code: codeView(after, families), lines: after.split('\n'), starts: lineStarts(after) }
  const found = new Map<string, SlopHit>()
  if (before.length <= MAX_SCAN_CHARS && !before.split('\n').some(line => line.length > MAX_SCAN_LINE)) {
    const previous: Scan = { raw: before, code: codeView(before, families), lines: before.split('\n'), starts: lineStarts(before) }
    if (testFile) {
      for (const hit of testWeakening(previous, scan, added, skip)) found.set(`${hit.line}:${hit.pattern}`, hit)
    } else if (families.includes('js') && !/(?:^|[/\\])(?:tests?|__tests__|__mocks__|fixtures?|mocks?)(?:[/\\]|$)|\.(?:mock|fixture)\.[^.]+$/i.test(path) &&
      !skip.has('requirement-substitution')) {
      for (const hit of requirementSubstitution(previous, scan, added, request)) found.set(`${hit.line}:${hit.pattern}`, hit)
    }
  }
  if (PY_TEST_FILE.test(path) && !skip.has('test-skip')) {
    for (const hit of pythonSkips(scan, added)) found.set(`${hit.line}:${hit.pattern}`, hit)
  }
  for (const rule of RULES) {
    if (skip.has(rule.pattern) || !rule.in.some(family => families.includes(family))) continue
    for (const match of (rule.view === 'raw' ? scan.raw : scan.code).matchAll(rule.regex)) {
      const first = lineAt(scan.starts, match.index)
      const last = lineAt(scan.starts, match.index + Math.max(0, match[0].length - 1))
      let touched = false
      for (let line = first; line <= last && !touched; line += 1) touched = added.has(line)
      if (!touched || (rule.keep && !rule.keep(match, scan, first))) continue
      const key = `${first}:${rule.pattern}`
      if (!found.has(key)) found.set(key, { line: first, pattern: rule.pattern, text: lineText(scan, first).trim().slice(0, 120), fix: rule.fix })
    }
  }
  const hits = [...found.values()]
  // A double cast or a cast to any is reported once, under its own pattern, not again as an unexplained assertion.
  const specific = new Set(hits.filter(hit => hit.pattern === 'chained-assertion' || hit.pattern === 'top-type').map(hit => hit.line))
  return hits.filter(hit => hit.pattern !== 'unreasoned-assertion' || !specific.has(hit.line)).sort((a, b) => a.line - b.line)
}

// The context the model reads after the tool's result.
export function slopNote(path: string, hits: readonly SlopHit[]): string {
  return [
    `[anti-slop] The lines just written match ${hits.length} pattern${hits.length === 1 ? '' : 's'} from the dag-workflow:anti-slop skill:`,
    ...hits.slice(0, MAX_NOTED_HITS).map(hit => `- ${path}:${hit.line} ${hit.pattern}: \`${hit.text}\` - ${hit.fix}`),
    ...(hits.length > MAX_NOTED_HITS ? [`- and ${hits.length - MAX_NOTED_HITS} more`] : []),
    'test-expectation-change and requirement-substitution are advisory candidates, not proof of cheating or hard rule violations. A valid requirement change or equivalent verification can justify them; explain the evidence, without automatic rollback or a failed verdict. Fix other hits unless a documented repository rule or skill exemption allows them. This scan sees shapes only.',
  ].join('\n')
}
