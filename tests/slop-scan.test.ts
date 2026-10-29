import { expect, test } from 'claude-code/testing'
import { addedLines, allowedPatterns, codeView, familiesOf, MAX_NOTED_HITS, MAX_SCAN_LINE, scanSlop, slopNote, type SlopHit } from '../hooks/engine/slop-scan.ts'

test('real API substitution also follows explicit Korean requests and exclusions', () => {
  const before = "export async function load() {\n  return fetch('/api/items')\n}"
  const after = "export async function load() {\n  return { ok: true }\n}"
  const hits = (request: string) => scanSlop('src/api.ts', before, after, new Set(), request).map(hit => hit.pattern)
  expect(hits('실제 API를 연동해주세요')).toContain('requirement-substitution')
  expect(hits('실제 API를 연동해주세요. 명령 실행과 DAG는 사용하지 마세요.')).toContain('requirement-substitution')
  for (const request of ['실제 API 연동은 필요 없음', '실제 API를 호출하지 마세요', '실제 API 대신 mock을 사용하세요', '실제 API 연동 예제를 문서로 작성하세요']) {
    expect(hits(request)).not.toContain('requirement-substitution')
  }
})

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

const TEST_BEFORE = "test('checks result', () => {\n  expect(load()).toBe(3)\n})"
const TEST_WEAKENING: [string, string, string, string[]][] = [
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('test(', 'test.skip('), ['test-skip']],
  ['a.spec.js', '', "it.skip('checks result', function () {\n  expect(load()).toBe(3)\n})", ['test-skip']],
  ['a.test.tsx', '', "xtest('checks result', () => {})", ['test-skip']],
  ['a.spec.mjs', '', "describe.skip('suite', () => {})", ['test-skip']],
  ['a.test.cts', '', "test.todo('checks result')", ['test-skip']],
  ['a.test.ts', '', "test.skipIf(true)('checks result', () => {})", ['test-skip']],
  ['a.test.js', '', "test.runIf(false)('checks result', () => {})", ['test-skip']],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace(', ()', ', { skip: true }, ()'), ['test-skip']],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('  expect(load()).toBe(3)\n', ''), ['test-disabled']],
  ['a.spec.ts', TEST_BEFORE, TEST_BEFORE.replace('  expect(load()).toBe(3)', '  return;\n  expect(load()).toBe(3)'), ['test-disabled']],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('expect(load()).toBe(3)', 'expect(true).toBe(true)'), ['test-tautology']],
  ['a.spec.jsx', TEST_BEFORE, TEST_BEFORE.replace('expect(load()).toBe(3)', 'expect(false).toBeFalsy()'), ['test-tautology']],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('expect(load()).toBe(3)', 'expect(42).toStrictEqual(42)'), ['test-tautology']],
  ['a.test.ts', TEST_BEFORE.replace('toBe(3)', 'toHaveLength(3)'), TEST_BEFORE.replace('expect(load()).toBe(3)', 'expect(true).toBe(true)'), ['test-tautology']],
  ['a.test.ts', TEST_BEFORE.replace('toBe(3)', 'not.toBe(0)'), TEST_BEFORE.replace('expect(load()).toBe(3)', 'expect(true).toBe(true)'), ['test-tautology']],
  ['a.test.ts', "test('checks result', () => {\n  assert.equal(load(), 3)\n})", "test('checks result', () => {\n  assert.strictEqual(1, 1)\n})", ['test-tautology']],
  ['a.test.ts', "test('checks result', () => {\n  assert.ok(load())\n})", "test('checks result', () => {\n  assert(true)\n})", ['test-tautology']],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('test(', 'test.only('), ['test-focus']],
  ['a.test.ts', '', "it.only('checks result', () => {})", ['test-focus']],
  ['a.spec.js', '', "describe.only('suite', () => {})", ['test-focus']],
  ['a.test.ts', '', "fit('checks result', () => {})", ['test-focus']],
  ['a.test.ts', '', "fdescribe('suite', () => {})", ['test-focus']],
  ['a.test.ts', "test.only('checks result', () => {\n  expect(load()).toBe(3)\n})", "test.only('checks result', () => {\n  expect(load()).toBe(3)\n})\n", []],
  ['a.test.ts', TEST_BEFORE, `${TEST_BEFORE}\nconst sample = "it.only('x', () => {})"`, []],
  ['a.test.ts', TEST_BEFORE, `${TEST_BEFORE}\n// fit('x', () => {})`, []],
  ['a.ts', '', "it.only('checks result', () => {})", []],
  ['test_a.py', '', '@pytest.mark.skip\ndef test_a():\n    pass', ['test-skip']],
  ['a_test.py', '', '@pytest.mark.skip(reason="flaky")\ndef test_a():\n    pass', ['test-skip']],
  ['tests/test_a.py', '', '@unittest.skip("later")\ndef test_a(self):\n    pass', ['test-skip']],
  ['test_a.py', '', '@pytest.mark.skipif(sys.platform == \'win32\', reason=\'x\')\ndef test_a():\n    pass', []],
  ['test_a.py', '', '@unittest.skipIf(sys.platform == \'win32\', \'x\')\ndef test_a(self):\n    pass', []],
  ['test_a.py', '', 'NOTE = "@pytest.mark.skip"\n# @pytest.mark.skip', []],
  ['test_a.py', '@pytest.mark.skip\ndef test_a():\n    pass', '@pytest.mark.skip\ndef test_a():\n    pass\n', []],
  ['helpers.py', '', '@pytest.mark.skip\ndef helper():\n    pass', []],
  ['a.ts', TEST_BEFORE, TEST_BEFORE.replace('test(', 'test.skip('), []],
  ['a.test.py', '', "test.skip('checks result', () => {})", []],
  ['a.test.ts', '', "test('new test', () => {\n  expect(true).toBe(true)\n})", []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('toBe(3)', 'toBe(4)'), ['test-expectation-change']],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('expect(load()).toBe(3)', 'expect(true).toBe(false)'), []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('expect(load()).toBe(3)', 'expect(true).not.toBe(true)'), []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('expect(load()).toBe(3)', 'expect(ready).toBe(true)'), []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('expect(load()).toBe(3)', 'return expect(load()).toBe(3)'), []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('checks result', 'renamed test'), []],
  ['a.test.ts', TEST_BEFORE.replace('test(', 'test.skip('), TEST_BEFORE.replace('test(', 'test.skip(').replace('checks result', 'renamed test'), []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('expect(load()).toBe(3)', 'checkResult(load())'), []],
  ['a.test.ts', `${TEST_BEFORE}\n${TEST_BEFORE.replace('checks result', 'duplicate')}`, TEST_BEFORE, []],
  ['a.test.ts', "test('checks result', () => {\n  expect(load()).toBe(3)\n  expect(size()).toBe(2)\n})", TEST_BEFORE, []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('expect(load()).toBe(3)', 'const sample = "expect(true).toBe(true)"'), []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('expect(load()).toBe(3)', 'const sample = /expect(true).toBe(true)/'), []],
  ['a.test.ts', TEST_BEFORE, `${TEST_BEFORE}\n/* test.skip('example', () => {}) */`, []],
  ['a.test.ts', TEST_BEFORE, `${TEST_BEFORE}\nconst sample = { skip: true, text: "test.skip('example')" }`, []],
  ['a.test.ts', '', "test.skipIf(offline)('checks result', () => {})", []],
  ['a.test.ts', '', "test('checks result', { skip: offline }, () => {})", []],
  ['a.test.ts', '', "test('checks result', () => {})", []],
  ['a.test.ts', TEST_BEFORE, `${TEST_BEFORE}\n// test.skip('example', () => {})`, []],
  ['a.test.ts', TEST_BEFORE.replace('toBe(3)', 'toBe(3)\n  expect(true).toBe(true)'), TEST_BEFORE.replace('expect(load()).toBe(3)', 'expect(true).toBe(true)'), []],
]

test('test weakening reports precise replacements and ignores look-alikes', () => {
  const wrong = TEST_WEAKENING.flatMap(([path, before, after, expected]) => {
    const found = scanSlop(path, before, after).map(hit => hit.pattern)
    return JSON.stringify(found) === JSON.stringify(expected) ? [] : [{ path, before, after, found, expected }]
  })
  expect(wrong).toEqual([])
})

test('deletion-only empty callbacks are scanned at their surviving declaration', () => {
  const after = TEST_BEFORE.replace('  expect(load()).toBe(3)\n', '')
  expect([...addedLines(TEST_BEFORE, after)]).toEqual([])
  expect(scanSlop('a.test.ts', TEST_BEFORE, after).map(hit => [hit.line, hit.pattern])).toEqual([[1, 'test-disabled']])
})

test('test weakening uses existing pattern skips and bounds both comparison inputs', () => {
  for (const [path, before, after, expected] of TEST_WEAKENING.filter(row => row[3].length > 0)) {
    expect(scanSlop(path, before, after, new Set(expected))).toEqual([])
  }
  const before = `${' '.repeat(MAX_SCAN_LINE + 1)}\n${TEST_BEFORE}`
  expect(scanSlop('a.test.ts', before, TEST_BEFORE.replace('expect(load()).toBe(3)', 'expect(true).toBe(true)'))).toEqual([])
})

const EXPECTATION_CHANGES: [string, string, string, string[]][] = [
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('toBe(3)', 'toBe(4)'), ['test-expectation-change']],
  ['a.spec.js', TEST_BEFORE.replace('test(', 'it('), TEST_BEFORE.replace('test(', 'it(').replace('toBe(3)', 'toBe(4)'), ['test-expectation-change']],
  ['a.test.tsx', TEST_BEFORE.replace('toBe(3)', "toEqual('old')"), TEST_BEFORE.replace('toBe(3)', "toEqual('new')"), ['test-expectation-change']],
  ['a.spec.mjs', TEST_BEFORE.replace('toBe(3)', 'resolves.toStrictEqual(null)'), TEST_BEFORE.replace('toBe(3)', 'resolves.toStrictEqual(false)'), ['test-expectation-change']],
  ['a.test.cts', TEST_BEFORE.replace('toBe(3)', 'toBe("a b")'), TEST_BEFORE.replace('toBe(3)', 'toBe("ab")'), ['test-expectation-change']],
  ['a.ts', TEST_BEFORE, TEST_BEFORE.replace('toBe(3)', 'toBe(4)'), []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('checks result', 'new contract').replace('toBe(3)', 'toBe(4)'), []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('load()', 'reload()').replace('toBe(3)', 'toBe(4)'), []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('toBe(3)', 'toEqual(4)'), []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('toBe(3)', 'not.toBe(4)'), []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('toBe(3)', 'toBe(limit)'), []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('expect(load()).toBe(3)', 'verify(load())'), []],
  ['a.test.ts', `${TEST_BEFORE}\n${TEST_BEFORE}`, `${TEST_BEFORE}\n${TEST_BEFORE.replace('toBe(3)', 'toBe(4)')}`, []],
  ['a.test.ts', TEST_BEFORE.replace('toBe(3)', 'toBe(3)\n  expect(load()).toBe(5)'), TEST_BEFORE.replace('toBe(3)', 'toBe(4)\n  expect(load()).toBe(5)'), []],
  ['a.test.ts', TEST_BEFORE.replace('toBe(3)', 'toBe(3)\n  expect(load()).toBe(limit)'), TEST_BEFORE.replace('toBe(3)', 'toBe(4)\n  expect(load()).toBe(limit)'), []],
  ['a.test.ts', TEST_BEFORE.replace('toBe(3)', 'toBe(3)\n  expect(size()).toBe(5)'), TEST_BEFORE.replace('toBe(3)', 'toBe(4)'), []],
  ['a.test.ts', TEST_BEFORE.replace('expect(', 'check('), TEST_BEFORE.replace('expect(', 'check(').replace('toBe(3)', 'toBe(4)'), []],
  ['a.test.ts', `const expect = check\n${TEST_BEFORE}`, `const expect = check\n${TEST_BEFORE.replace('toBe(3)', 'toBe(4)')}`, []],
  ['a.test.ts', `import { check as expect } from 'check'\n${TEST_BEFORE}`, `import { check as expect } from 'check'\n${TEST_BEFORE.replace('toBe(3)', 'toBe(4)')}`, []],
  ['a.test.ts', TEST_BEFORE.replace('expect(load()).toBe(3)', '// expect(load()).toBe(3)'), TEST_BEFORE.replace('expect(load()).toBe(3)', '// expect(load()).toBe(4)'), []],
  ['a.test.ts', TEST_BEFORE.replace('expect(load()).toBe(3)', 'const text = "expect(load()).toBe(3)"'), TEST_BEFORE.replace('expect(load()).toBe(3)', 'const text = "expect(load()).toBe(4)"'), []],
  ['a.test.ts', TEST_BEFORE.replace('load()', 'load("a")'), TEST_BEFORE.replace('load()', 'load("b")').replace('toBe(3)', 'toBe(4)'), []],
  ['a.test.ts', TEST_BEFORE, TEST_BEFORE.replace('toBe(3)', 'toBe(3.0)'), []],
  ['a.test.ts', TEST_BEFORE.replace('toBe(3)', "toBe('same')"), TEST_BEFORE.replace('toBe(3)', 'toBe("same")'), []],
  ['a.test.ts', TEST_BEFORE.replace('toBe(3)', 'toBe("a")'), TEST_BEFORE.replace('toBe(3)', 'toBe("\\u0061")'), []],
  ['a.test.ts', `const { expect } = helpers\n${TEST_BEFORE}`, `const { expect } = helpers\n${TEST_BEFORE.replace('toBe(3)', 'toBe(4)')}`, []],
  ['a.test.ts', `describe('old suite', () => {\n${TEST_BEFORE}\n})`, `describe('new suite', () => {\n${TEST_BEFORE.replace('toBe(3)', 'toBe(4)')}\n})`, []],
]

test('expectation changes require unique unchanged named assertions with literal expectations', () => {
  const wrong = EXPECTATION_CHANGES.flatMap(([path, before, after, expected]) => {
    const found = scanSlop(path, before, after).map(hit => hit.pattern)
    return JSON.stringify(found) === JSON.stringify(expected) ? [] : [{ path, before, after, found, expected }]
  })
  expect(wrong).toEqual([])
})

const LIVE_REQUEST = 'Implement a real API integration.'
const LIVE_BEFORE = 'export async function load() {\n  return await fetch(url)\n}'
const FIXED_AFTER = 'export async function load() {\n  return { ok: true, users: [] }\n}'
const SUBSTITUTIONS: [string, string, string, string, string[]][] = [
  ['src/api.ts', LIVE_BEFORE, FIXED_AFTER, LIVE_REQUEST, ['requirement-substitution']],
  ['src/api.js', LIVE_BEFORE, FIXED_AFTER.replace('{ ok: true, users: [] }', 'Response.json({ ok: true })'), 'Use a live API.', ['requirement-substitution']],
  ['src/api.mts', LIVE_BEFORE.replace('await fetch(url)', 'fetch(url)'), FIXED_AFTER.replace('{ ok: true, users: [] }', 'Promise.resolve("offline")'), LIVE_REQUEST, ['requirement-substitution']],
  ['src/api.ts', LIVE_BEFORE, FIXED_AFTER, 'TASK: Implement a real API integration, not a mock.', ['requirement-substitution']],
  ['src/api.ts', LIVE_BEFORE, FIXED_AFTER, '', []],
  ['src/api.ts', LIVE_BEFORE, FIXED_AFTER, 'Implement the API integration.', []],
  ['src/api.ts', LIVE_BEFORE, FIXED_AFTER, 'Do not implement a real API integration.', []],
  ['src/api.ts', LIVE_BEFORE, FIXED_AFTER, 'Implement a real API integration without live calls.', []],
  ['src/api.ts', LIVE_BEFORE, FIXED_AFTER, 'The docs mention a real API.', []],
  ['src/api.ts', LIVE_BEFORE, FIXED_AFTER, 'Implement real API documentation.', []],
  ['src/api.ts', LIVE_BEFORE, FIXED_AFTER, 'Implement a real-time API.', []],
  ['src/api.ts', LIVE_BEFORE, FIXED_AFTER, 'Implement a real API integration using mock responses.', []],
  ['src/api.ts', LIVE_BEFORE, FIXED_AFTER, 'Implement a real API integration; it is optional.', []],
  ['src/api.test.ts', LIVE_BEFORE, FIXED_AFTER, LIVE_REQUEST, []],
  ['tests/api.ts', LIVE_BEFORE, FIXED_AFTER, LIVE_REQUEST, []],
  ['src/__mocks__/api.js', LIVE_BEFORE, FIXED_AFTER, LIVE_REQUEST, []],
  ['fixtures/api.ts', LIVE_BEFORE, FIXED_AFTER, LIVE_REQUEST, []],
  ['src/api.mock.ts', LIVE_BEFORE, FIXED_AFTER, LIVE_REQUEST, []],
  ['src/api.ts', '', FIXED_AFTER, LIVE_REQUEST, []],
  ['src/api.ts', LIVE_BEFORE, LIVE_BEFORE.replace('fetch(url)', 'fetch(otherUrl)'), LIVE_REQUEST, []],
  ['src/api.ts', LIVE_BEFORE, FIXED_AFTER.replace('function load()', 'function cached()'), LIVE_REQUEST, []],
  ['src/api.ts', LIVE_BEFORE, FIXED_AFTER.replace('{ ok: true, users: [] }', 'cache'), LIVE_REQUEST, []],
  ['src/api.ts', LIVE_BEFORE, FIXED_AFTER.replace('{ ok: true, users: [] }', 'loadFixture()'), LIVE_REQUEST, []],
  ['src/api.ts', LIVE_BEFORE.replace('fetch(url)', 'client.fetch(url)'), FIXED_AFTER, LIVE_REQUEST, []],
  ['src/api.ts', LIVE_BEFORE.replace('return await fetch(url)', 'const text = "fetch(url)"\n  return text'), FIXED_AFTER, LIVE_REQUEST, []],
  ['src/api.ts', LIVE_BEFORE.replace('return await fetch(url)', '// return await fetch(url)\n  return 3'), FIXED_AFTER, LIVE_REQUEST, []],
  ['src/api.ts', `const fetch = fake\n${LIVE_BEFORE}`, `const fetch = fake\n${FIXED_AFTER}`, LIVE_REQUEST, []],
  ['src/api.ts', `${LIVE_BEFORE}\n${LIVE_BEFORE}`, FIXED_AFTER, LIVE_REQUEST, []],
  ['src/api.ts', LIVE_BEFORE.replace('return await fetch(url)', 'return { fetch: true }'), FIXED_AFTER, LIVE_REQUEST, []],
  ['src/api.ts', `test('network fake', () => {\n${LIVE_BEFORE}\n})`, `test('network fake', () => {\n${FIXED_AFTER}\n})`, LIVE_REQUEST, []],
  ['src/api.ts', `const { fetch } = fake\n${LIVE_BEFORE}`, `const { fetch } = fake\n${FIXED_AFTER}`, LIVE_REQUEST, []],
]

test('requirement substitution needs explicit live context and a recognized network replacement', () => {
  const wrong = SUBSTITUTIONS.flatMap(([path, before, after, request, expected]) => {
    const found = scanSlop(path, before, after, undefined, request).map(hit => hit.pattern)
    return JSON.stringify(found) === JSON.stringify(expected) ? [] : [{ path, before, after, request, found, expected }]
  })
  expect(wrong).toEqual([])
})

test('advisory scans obey configured and repository pattern skips and comparison bounds', () => {
  for (const [path, before, after, expected] of EXPECTATION_CHANGES.filter(row => row[3].length > 0)) {
    expect(scanSlop(path, before, after, new Set(expected))).toEqual([])
    expect(scanSlop(path, before, after, new Set(allowedPatterns('anti-slop allow: test-expectation-change')))).toEqual([])
  }
  expect(scanSlop('src/api.ts', LIVE_BEFORE, FIXED_AFTER, new Set(['requirement-substitution']), LIVE_REQUEST)).toEqual([])
  expect(scanSlop('src/api.ts', LIVE_BEFORE, FIXED_AFTER, new Set(allowedPatterns('anti-slop allow: requirement-substitution')), LIVE_REQUEST)).toEqual([])
  expect(scanSlop('src/api.ts', `${' '.repeat(MAX_SCAN_LINE + 1)}\n${LIVE_BEFORE}`, FIXED_AFTER, undefined, LIVE_REQUEST)).toEqual([])
  expect(scanSlop('src/api.ts', LIVE_BEFORE, `${' '.repeat(MAX_SCAN_LINE + 1)}\n${FIXED_AFTER}`, undefined, LIVE_REQUEST)).toEqual([])
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
