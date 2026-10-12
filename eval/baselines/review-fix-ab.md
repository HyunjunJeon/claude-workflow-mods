# Review FAIL handling: control against treatment
Date: 2026-10-12
Treatment: the working tree with the verdict guard (recovery.ts verdictFailure) and the review-fix round (rework.ts), on top of d7fcfc8 and the other uncommitted speed fixes.
Control: the same tree copied, with only those two features switched off (verdictFailure returns false and attemptRework returns undefined), so the audit budget and the other fixes are equal on both arms.
Stamps 20261012150726 and 20261012150728. Each stamp ran one control and one treatment session at the same time, four sessions in all, model sonnet, enforcement strict through --settings pluginConfigs.

## Seeded fixture
A git repository holding sample.txt ("one two three") and flows/seeded.json. The producer's prompt leaves out the missing-file behaviour that the review request asks for, so review-spec is expected to fail on finding group (a):

```json
{
  "key": "seeded-wc",
  "name": "Seeded wc",
  "goal": "wc.py prints the number of words in a text file",
  "nodes": [
    {
      "id": "cli",
      "category": "quick",
      "prompt": "TASK: Create wc.py in the project root: a Python 3 script that prints the number of words in the file named by its first argument, as a bare integer on one line.\nDELIVERABLE: wc.py\nSCOPE: write only wc.py\nVERIFY: python3 wc.py sample.txt prints 3\nSTOP WHEN: the check passes",
      "writes": ["wc.py"],
      "verify": [{ "kind": "command", "argv": ["python3", "wc.py", "sample.txt"], "expect": { "stdout": { "equals": "3" } } }]
    }
  ],
  "review": {
    "request": "Create wc.py that prints the number of words in the file given as its first argument. When the file does not exist it must print `error: no such file: <name>` to stderr and exit with code 2."
  }
}
```

Prompt to each session: "Start the DAG defined in flows/seeded.json with the dag tool: action start with path flows/seeded.json. Do not edit the definition file before starting. When the run settles, make sure the request in its review field is met before you report."

## Result

| session | total s | first settle | Opus attempts | review-spec attempts | main amends | final check (python3 wc.py missing.txt) |
| --- | --- | --- | --- | --- | --- | --- |
| control 20261012150726 | 520 | failed at 413 s | 2 (227 s, 141 s) | 4 | 1 | exit 2, error: no such file |
| control 20261012150728 | 555 | failed at 360 s | 2 (174 s, 118 s) | 4 | 1 | exit 2, error: no such file |
| treatment 20261012150726 | 127 | completed at 116 s | 0 | 2 | 0 | exit 2, error: no such file |
| treatment 20261012150728 | 338 | failed at 264 s | 0 | 3 | 1 | exit 2, error: no such file |

Mean total time: 538 s for the control, 233 s for the treatment (-57%). All four sessions ended with the requested behaviour.

- Control: review-spec failed, then automatic recovery retried it twice on Opus. Both retries returned the same finding and took 292-368 s together. The run then settled failed, and the main conversation amended cli.
- Treatment 150726: review-spec failed, and the review-fix round reran cli (14 s) with the findings. Both reviewers passed on the next round.
- Treatment 150728: the fix round reran cli. review-spec then failed on a new finding: the fix added an unrequested `except OSError` branch. The round was spent, so the run settled for the main conversation, which amended cli once more.

Two pairs is a small sample, and reviewer time varied from 26 to 188 s per attempt. The direction matches the real-project count (eval/baselines/speed-fixes-ab.md and the 2026-10-12 transcripts): there, 7 Opus retries in four ryan-heart runs repeated their verdict for 54 minutes.
