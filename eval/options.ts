export type Options = {
  list: boolean
  only?: string[]
  concurrency: number
  model: string
  timeoutMin: number
  keep: boolean
  enforcement?: string
  repeat: number
}

export type ParsedArgs = { options: Options } | { error: string }

export const USAGE =
  'Usage: bun eval/run.ts [--list] [--only id,id] [--concurrency n] [--model name] [--timeout-min n] [--keep] [--enforcement strict|auto] [--repeat k] [--confirm-usage]'

// Above this many samples per scenario the run needs --confirm-usage, because each sample is a real claude -p session on the user's account.
export const REPEAT_WITHOUT_CONFIRMATION = 3

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const value = (flag: string) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const repeatText = argv.includes('--repeat') ? (value('--repeat') ?? '') : '1'
  if (!/^[1-9]\d*$/.test(repeatText)) return { error: `--repeat must be a positive integer, got "${repeatText}"` }
  const repeat = Number(repeatText)
  const list = argv.includes('--list')
  if (!list && repeat > REPEAT_WITHOUT_CONFIRMATION && !argv.includes('--confirm-usage')) {
    return { error: `--repeat ${repeat} starts ${repeat} real claude -p sessions per scenario; pass --confirm-usage to run more than ${REPEAT_WITHOUT_CONFIRMATION} repeats` }
  }
  const only = value('--only')
  const enforcement = value('--enforcement')
  return {
    options: {
      list,
      ...(only ? { only: only.split(',') } : {}),
      concurrency: Number(value('--concurrency') ?? 4),
      model: value('--model') ?? 'sonnet',
      timeoutMin: Number(value('--timeout-min') ?? 15),
      keep: argv.includes('--keep'),
      ...(enforcement ? { enforcement } : {}),
      repeat,
    },
  }
}
