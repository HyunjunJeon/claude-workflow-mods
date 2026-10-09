export type Scenario = {
  id: string
  expect: string
  prompt: string
  files: Record<string, string>
  check: string
  unchanged?: string[]
}

// 450 files hold 675 TODOs, above the doctrine's 200 items per quick node, so a plan that follows it needs at least three batches and a fan-in.
const todoFiles = Object.fromEntries(
  Array.from({ length: 450 }, (_, i) => {
    const n = i + 1
    const todos = Array.from({ length: n % 4 }, (_, k) => `# TODO: follow-up ${k + 1} for module ${n}`)
    const body = [`"""Module ${n}."""`, '', `def value_${n}():`, `    return ${n}`, '', ...todos, ''].join('\n')
    return [`src/mod_${String(n).padStart(3, '0')}.py`, body]
  }),
)

export const SCENARIOS: Scenario[] = [
  {
    id: 'single-edit',
    expect: 'single',
    prompt: 'In counter.py, rename the local variable x to count without changing behavior.',
    files: {
      'counter.py': 'def tally(items):\n    x = 0\n    for item in items:\n        if item:\n            x += 1\n    return x\n\n\nif __name__ == "__main__":\n    print(tally([1, 0, 2, None, 3]))\n',
    },
    check: `python3 -c "import counter; assert counter.tally([1, 0, 2, None, 3]) == 3" && grep -q "count" counter.py && ! grep -Eq "\\bx\\b" counter.py`,
  },
  {
    id: 'parallel-files',
    expect: 'parallel',
    prompt: 'Add three project files: an MIT LICENSE for "Example Org" (2026), an .editorconfig that sets 2-space indentation for all files, and a CONTRIBUTING.md with the sections Setup, Style and Pull requests.',
    files: { 'README.md': '# demo\n' },
    check: 'grep -q "MIT" LICENSE && grep -q "Example Org" LICENSE && grep -q "indent_size *= *2" .editorconfig && grep -qi "setup" CONTRIBUTING.md && grep -qi "style" CONTRIBUTING.md && grep -qi "pull request" CONTRIBUTING.md',
  },
  {
    id: 'map-reduce-docs',
    expect: 'fan-out/fan-in',
    prompt: 'Fix the spelling mistakes in every file under docs/, then write docs/CHANGES.md that lists, per file, each word you corrected.',
    files: {
      'docs/intro.md': '# Intro\n\nThsi project helps you mangae tasks.\n',
      'docs/install.md': '# Install\n\nRun the instaler and folow the prompts.\n',
      'docs/usage.md': '# Usage\n\nType a comand and press entr.\n',
      'docs/config.md': '# Config\n\nEdit the setings file to chnage defaults.\n',
      'docs/faq.md': '# FAQ\n\nMost questons are answred here.\n',
      'docs/support.md': '# Support\n\nContact us for halp with anythign.\n',
    },
    check: '! grep -qiE "thsi|mangae|instaler|folow|comand|entr\\b|setings|chnage|questons|answred|halp|anythign" docs/intro.md docs/install.md docs/usage.md docs/config.md docs/faq.md docs/support.md && test -s docs/CHANGES.md',
  },
  {
    id: 'pipeline-stats',
    expect: 'chain',
    prompt: 'Create gen.py that writes data.csv with columns n and square for n = 1..20 and run it. Then create stats.py that reads data.csv and writes the mean of each column to stats.json, and run it. Finally write report.md that presents the numbers from stats.json as a markdown table.',
    files: {},
    check: `python3 -c "import json; s = json.load(open('stats.json')); v = sorted(float(x) for x in (s.values() if isinstance(s, dict) else s)); assert 10.5 in v and 143.5 in v, s" && grep -q "143.5" report.md`,
  },
  {
    id: 'diamond-app',
    expect: 'diamond',
    prompt: 'Build a tiny Python app: settings.py exposing SETTINGS = {"greeting": "hi", "repeat": 2}; greeter.py with greet(name) returning "<greeting>, <name>" using SETTINGS; repeater.py with repeat_text(text) repeating text SETTINGS["repeat"] times joined by spaces; main.py printing repeat_text(greet("ada")); and test_app.py with plain asserts for greet, repeat_text and main that prints OK when run with python3 test_app.py.',
    files: {},
    check: 'python3 test_app.py | grep -q OK && python3 main.py | grep -q "hi, ada"',
  },
  {
    id: 'debug-fix',
    expect: 'chain',
    prompt: 'python3 test_mathutil.py fails. Find out why and fix mathutil.py; do not change the test.',
    files: {
      'mathutil.py': 'def average(values):\n    if not values:\n        return 0\n    return sum(values) // len(values)\n\n\ndef clamp(value, low, high):\n    return max(low, min(value, high))\n',
      'test_mathutil.py': 'from mathutil import average, clamp\n\nassert average([1, 2]) == 1.5, average([1, 2])\nassert average([]) == 0\nassert clamp(5, 0, 3) == 3\nprint("OK")\n',
    },
    check: 'python3 test_mathutil.py | grep -q OK',
    unchanged: ['test_mathutil.py'],
  },
  {
    id: 'wide-harvest',
    expect: 'fan-out/fan-in',
    prompt: 'Count the TODO comments in every file under src/ and write todo-report.md with a per-file table and the grand total.',
    files: todoFiles,
    check: 'grep -Eq "\\b675\\b" todo-report.md && grep -q "mod_450" todo-report.md',
  },
  {
    id: 'research-write',
    expect: 'fan-out/fan-in',
    prompt: 'Write sorting.md comparing bubble sort, merge sort and quicksort: for each one a short description, its time and space complexity and a short Python implementation, then a final recommendation section.',
    files: {},
    check: 'grep -qi "bubble" sorting.md && grep -qi "merge sort" sorting.md && grep -qi "quicksort\\|quick sort" sorting.md && grep -qi "recommend" sorting.md',
  },
]
