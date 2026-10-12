import { expect, test } from 'claude-code/testing'
import { addedLines, allowedPatterns, codeView, familiesOf, MAX_NOTED_HITS, MAX_SCAN_LINE, scanSlop, slopNote, type SlopHit } from '../hooks/engine/slop-scan.ts'

// [file, new text, the patterns the scan reports]. Every pattern has at least one case it must report and one look-alike
// it must leave alone, because a false hit reaches the model after every edit.
const CASES: [string, string, string[]][] = [
  ['a.ts', '// TODO: handle the empty cart', ['todo-stub']],
  ['a.py', '# FIXME: retry on timeout', ['todo-stub']],
  ['a.ts', 'const note = "a TODO list app"', []],
  ['a.js', 'debugger', ['debug-leftover']],
  ['a.py', 'breakpoint()', ['debug-leftover']],
  ['a.rs', 'let x = dbg!(y);', ['debug-leftover']],
  ['a.rb', 'binding.pry', ['debug-leftover']],
  ['A.java', 'error.printStackTrace();', ['debug-leftover']],
  ['a.ts', '// const total = sum(items);', ['commented-out-code']],
  ['a.ts', '// Retry once: the host drops the first request (measured 2026-10-01).', []],
  ['a.py', '# total = compute(items)', ['commented-out-code']],
  ['a.py', '# n = number of samples\n# return the value', []],
  ['a.ts', 'try { load() } catch {}', ['swallowed-error']],
  ['A.java', 'try { load(); } catch (IOException e) {}', ['swallowed-error']],
  ['a.ts', 'try { load() } catch { /* the cache file may not exist yet */ }', []],
  ['a.ts', 'const sample = "catch {}"', []],
  ['a.py', 'try:\n    load()\nexcept ValueError:\n    pass', ['swallowed-error']],
  ['a.py', 'try:\n    load()\nexcept ValueError:\n    # optional field\n    pass', []],
  ['a.go', 'if err != nil {\n}', ['swallowed-error']],
  ['a.rb', 'begin\n  load\nrescue => e\nend', ['swallowed-error']],
  ['a.ts', 'try { load() } catch (error) { throw error }', ['rethrow-only-catch']],
  ['a.ts', 'try { load() } catch (error) { throw new LoadError(error) }', []],
  ['A.java', 'try { load(); } catch (IOException e) { throw e; } catch (Exception e) { report(e); }', []],
  ['a.py', 'try:\n    load()\nexcept KeyError as e:\n    raise e\n', ['rethrow-only-catch']],
  ['a.py', 'try:\n    load()\nexcept KeyboardInterrupt:\n    raise\nexcept Exception:\n    report()\n', []],
  ['a.ts', 'const ok = count > 0 ? true : false', ['boolean-ceremony']],
  ['a.ts', 'type IsText<T> = T extends string ? true : false', []],
  ['a.ts', 'if (count > 0) {\n  return true\n}\nreturn false', ['boolean-ceremony']],
  ['a.ts', 'if (ready) {\n  log()\n  return true\n}\nreturn false', []],
  ['a.ts', 'while (i < n) {\n  if (seen(i)) return true\n  i++\n}\nreturn false', []],
  ['a.ts', 'while (i < n) {\n  const c = s[i++]\n  if (c === d) return true\n}\nreturn false', []],
  ['a.ts', 'if (count > 0) {\n  return true\n} else {\n  return false\n}', ['boolean-ceremony']],
  ['a.go', 'if n > 0 {\n\treturn true\n}\nreturn false', ['boolean-ceremony']],
  ['a.py', 'return True if x else False', ['boolean-ceremony']],
  ['a.py', 'if x > 0:\n    return True\nreturn False', ['boolean-ceremony']],
  ['a.ts', 'const result = compute(a)\nreturn result', ['pass-through-variable']],
  ['a.ts', 'const total = compute(a)\nreturn total', []],
  ['a.ts', 'const result: Total = compute(a)\nreturn result', []],
  ['a.py', 'def f(a):\n    result = compute(a)\n    return result', ['pass-through-variable']],
  ['a.go', 'result := compute(a)\nreturn result', ['pass-through-variable']],
  ['A.java', 'List<User> result = repository.findAll();\nreturn result;', ['pass-through-variable']],
  ['a.ts', 'const user = input as unknown as User', ['chained-assertion']],
  ['a.ts', 'const raw = input as any', ['top-type']],
  ['a.ts', 'async function load(): Promise<any> {', ['top-type']],
  ['a.ts', 'type Payload = unknown', ['top-type']],
  ['a.ts', 'function handle(input: any, options: object) {', ['top-type']],
  ['a.ts', 'function isUser(value: any): value is User {', []],
  ['a.ts', '} catch (error: any) {', []],
  ['a.ts', 'export function parseConfig(raw: unknown): Config {\nfunction parseYaml(source: string): unknown {', []],
  ['a.py', 'def load(raw: Any) -> dict[str, Any]:', ['top-type']],
  ['a.go', 'func handle(v interface{}) {', ['top-type']],
  ['A.java', 'public void save(Object value) {', ['top-type']],
  ['A.java', 'Object lock = new Object();\npublic boolean equals(Object other) {', []],
  ['a.ts', 'type Meta = Record<string, unknown>', ['open-dictionary']],
  ['a.ts', 'type Meta = { [key: string]: any }', ['open-dictionary']],
  ['a.ts', 'function keys<T extends Record<string, unknown>>(value: T) {', []],
  ['a.ts', 'function isRecord(value: unknown): value is Record<string, unknown> {', []],
  ['A.java', 'Map<String, Object> payload = parse(body);', ['open-dictionary']],
  ['a.ts', 'const id = value as UserId', ['unreasoned-assertion']],
  ['a.ts', '// SAFETY: parseUserId validated the id before branding it.\nconst id = value as UserId', []],
  ['a.ts', "import { load as loadUser } from './users.ts'\nconst modes = ['a', 'b'] as const\nconst label = 'save as Draft'", []],
  ['a.py', 'user = cast(User, raw)', ['unreasoned-assertion']],
  ['a.py', '# SAFETY: the schema check above accepted raw.\nuser = cast(User, raw)', []],
  ['a.go', 'name := v.(string)', ['unreasoned-assertion']],
  ['a.go', 'name, ok := v.(string)', []],
  ['a.rs', 'let x = unsafe { ptr.read() };', ['unreasoned-assertion']],
  ['a.rs', '// SAFETY: ptr comes from a live Box.\nlet x = unsafe { ptr.read() };', []],
  ['A.java', 'User user = (User) cache.get(key);', ['unreasoned-assertion']],
  ['A.java', 'if (READY) start();\nint n = (int) total;\nrun(Config.load());', []],
  ['a.ts', '// @ts-ignore\nload()', ['suppression-without-reason']],
  ['a.ts', '// @ts-expect-error -- the host typings miss this field\nload()', []],
  ['a.ts', 'const directive = /@ts-ignore\\b/', []],
  ['a.js', '// eslint-disable-next-line no-console\nlog()', ['suppression-without-reason']],
  ['a.js', '// eslint-disable-next-line no-console -- the CLI prints its result\nlog()', []],
  ['a.py', 'x = f()  # type: ignore', ['suppression-without-reason']],
  ['a.py', 'x = f()  # type: ignore[attr-defined]\ny = g()  # noqa: E501', []],
  ['a.go', 'f() //nolint', ['suppression-without-reason']],
  ['a.go', 'f() //nolint:errcheck // best-effort cleanup', []],
  ['A.java', '@SuppressWarnings("unchecked")\nList<User> users = load();', ['suppression-without-reason']],
  ['A.java', '// The legacy API returns a raw List of User.\n@SuppressWarnings("unchecked")\nList<User> users = load();', []],
  ['a.ts', 'const value = Reflect.get(owner, key)', ['reflection']],
  ['a.py', 'value = getattr(owner, "name")', ['reflection']],
  ['a.py', 'value = getattr(owner, name, None)', []],
  ['a.ts', 'const emails = users.filter(user => user.active).map(user => user.email)', ['two-pass-filter-map']],
  ['a.ts', 'const emails = users.values().filter(user => user.active).map(user => user.email).toArray()', []],
  ['a.ts', 'const byId = items.reduce((acc, item) => ({ ...acc, [item.id]: item }), {})', ['growing-copy']],
  ['a.ts', 'const all = items.reduce((acc, item) => {\n  return [...acc, item]\n}, [])', ['growing-copy']],
  ['a.ts', 'const all = items.reduce((acc, item) => { acc.push(item); return acc }, [])', []],
  ['a.ts', 'const options = { ...(timeout !== undefined ? { timeout } : {}) }', ['conditional-empty-spread']],
  ['a.ts', "vi.mock('./user-store')", ['module-mock']],
  ['ATest.java', 'try (var mocked = Mockito.mockStatic(Clock.class)) {', ['module-mock']],
  ['README.md', '// TODO: write this', []],
]

test('each pattern reports its own shape and leaves the look-alikes alone', () => {
  const wrong = CASES.flatMap(([path, text, expected]) => {
    const found = scanSlop(path, '', text).map(hit => hit.pattern)
    return JSON.stringify(found) === JSON.stringify(expected) ? [] : [`${path}: ${JSON.stringify(text)} -> ${JSON.stringify(found)}, expected ${JSON.stringify(expected)}`]
  })
  expect(wrong).toEqual([])
})

test('only lines the edit adds are reported, so code it kept or re-indented is not', () => {
  const before = 'const id = value as UserId\nfunction keep() {}'
  const after = 'function keep() {}\n  const id = value as UserId\nconst raw = input as any'
  expect(scanSlop('a.ts', before, after).map(hit => [hit.line, hit.pattern])).toEqual([[3, 'top-type']])
  expect([...addedLines('a\nb\nb', 'b\nb\nb\n\nc')]).toEqual([3, 5])
})

test('a minified or generated file is not scanned', () => {
  expect(scanSlop('a.min.js', '', `debugger;${'x'.repeat(MAX_SCAN_LINE)}`)).toEqual([])
})

test('a rule file allows patterns on anti-slop allow lines, in a list item or not', () => {
  const rules = '# Rules\n- anti-slop allow: `open-dictionary`, two-pass-filter-map (parsers)\nAnti-slop allow: top-type\nanti-slop is great: debug-leftover'
  expect(allowedPatterns(rules)).toEqual(['open-dictionary', 'two-pass-filter-map', 'top-type'])
})

test('a pattern the user skips is never reported', () => {
  expect(scanSlop('a.ts', '', 'const id = value as UserId', new Set(['unreasoned-assertion']))).toEqual([])
})

test('the code view blanks strings and comments and keeps every offset', () => {
  const text = 'const a = "x // y" // note\nconst b = `as ${c}`'
  const view = codeView(text, familiesOf('a.ts'))
  expect(view.length).toBe(text.length)
  expect(view).toBe('const a = "      "        \nconst b = `       `')
  expect(codeView('s = """a\n#b"""  # c', familiesOf('a.py'))).toBe('s = """ \n  """     ')
})

test('the note places each hit in the file and caps the list', () => {
  const hit: SlopHit = { line: 2, pattern: 'top-type', text: 'const raw = input as any', fix: 'parse it' }
  const note = slopNote('src/a.ts', [hit])
  expect(note).toContain('- src/a.ts:2 top-type: `const raw = input as any` - parse it')
  expect(note.startsWith('[anti-slop] The lines just written match 1 pattern from the dag-workflow:anti-slop skill:')).toBe(true)
  const many = slopNote('a.ts', Array.from({ length: MAX_NOTED_HITS + 3 }, () => hit))
  expect(many).toContain('- and 3 more')
})
