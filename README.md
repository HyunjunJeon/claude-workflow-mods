# dag-workflow

Claude Code mod로 만든 의존성 그래프(DAG) 워크플로우입니다. omo의 mass-ulw DAG 엔진(`workflow` 도구)과 [omo-herdr-dag](https://github.com/jc01rho/omo-herdr-dag) 뷰어가 하는 일을 Claude Code 안에서 합니다.

- **DAG 사용은 강제입니다.** 메인 대화는 계획, 읽기, 질문, 오케스트레이션만 하고, 실제 작업은 모두 DAG 노드에서 합니다([강제](#강제)).
- 노드는 Claude Code 서브에이전트로 실행되고, 의존성이 풀리는 순서대로 병렬 웨이브로 돕니다.
- 각 노드의 결과는 그 노드에 의존하는 노드와 메인 대화로 전달됩니다([결과 전달](#결과-전달)).
- 실행 상태는 노드 단위 State로 `.claude/dag/runs/<run_id>.json`에, 노드별 전체 보고서는 `.claude/dag/runs/<run_id>/<node>.md`에 저장됩니다.
- 진행 상황은 오른쪽 DAG 패널에 실시간으로 그려집니다.

Claude Code v2.1.287 이상이 필요합니다(mod 지원 버전).

## 불러오기

```bash
claude --plugin-dir /path/to/claude-workflow-mods
```

플래그 없이 모든 세션에서 항상 불러오려면 `~/.claude/settings.json`의 `env`에 플러그인 경로를 넣습니다. 이렇게 하면 어느 디렉터리에서 시작하든 강제와 계획 스킬이 켜진 상태로 시작합니다. `--plugin-dir`을 함께 줘도 한 번만 불러옵니다.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-workflow-mods"
  }
}
```

## 사용법

**평소처럼 요청하기**: 따로 말하지 않아도 Claude가 작업을 DAG로 계획해 `mcp__dag-workflow__dag` 도구로 실행합니다. `start`는 바로 반환되고, 실행이 끝나면(정착하면) 노드별 결과가 담긴 요약 메시지가 세션에 들어옵니다.

**파일로 실행하기**:

```text
/dag run flows/review.yaml      JSON 또는 YAML 정의 파일 실행
/dag                            DAG 패널 열기
/dag list                       이 프로젝트의 실행 목록
/dag status <run_id>            노드별 상태
/dag cancel <run_id>            실행 취소(실행 중인 노드 에이전트 중단)
/dag retry <run_id> [node...]   실패/취소된 노드 다시 실행
/dag enforce [strict|guide|off] 이 세션의 강제 수준 확인·변경
```

## 강제

기본값인 `strict`에서는 네 가지가 함께 동작합니다.

1. **도구 게이트**: 메인 대화에서 모델이 호출하는 도구 중 다음을 제외한 모든 도구를 거부합니다. 거부할 때는 "이 작업을 DAG 노드로 옮겨 `start`나 `amend`하라"는 안내를 돌려줍니다.
   - 허용: dag 도구, Read, LSP, WebFetch/WebSearch, AskUserQuestion, 계획 모드, 작업 조회·중단(TaskList/TaskGet/TaskStop), 읽기 전용 Bash
   - 읽기 전용 Bash: `ls`, `cat`, `rg`, `find`(‐exec/‐delete 제외), `git status/log/diff/show/...` 등. 출력 리다이렉트(`>`), 명령 치환(`$(...)`), 목록에 없는 명령이 하나라도 있으면 거부합니다.
   - 거부: Edit, Write, NotebookEdit, Agent, Workflow, TodoWrite/TaskCreate(계획은 DAG로만), 쓰기 Bash, 그 밖의 MCP 도구
   - DAG 노드 에이전트와 플러그인 자신의 호출(노드 spawn, TaskStop)은 제한하지 않습니다.
2. **프로토콜 주입**: 사용자 프롬프트마다 "계획을 DAG로 짜서 실행하고, 의존 관계를 정확히 적고, 정착 요약을 확인하라"는 짧은 지침을 붙입니다.
3. **도구 설명**: dag 도구 설명에 같은 원칙을 넣습니다.

4. **계획 스킬 게이트**: 세션의 첫 `start`/`amend`는 `dag-workflow:dag-planning` 스킬을 불러오기 전까지 `planning_skill_required`로 거부됩니다([계획 스킬](#계획-스킬)). `/clear`하면 다시 불러와야 합니다. 사용자가 직접 실행하는 `/dag run`은 게이트하지 않습니다.

`guide`는 2·3만 적용하고 스킬을 안 불렀으면 경고만 남기며, `off`는 아무것도 하지 않습니다. 다른 도구를 메인에서 계속 쓰려면 `main_allowed_tools` 설정에 이름을 추가합니다.

## 계획 스킬

omo mass-ulw의 스킬 구조를 따른 `skills/dag-planning/`이 플러그인에 들어 있습니다(`/dag-workflow:dag-planning`).

- `SKILL.md`: 언제 쓰나, 정의 형태(노드 필드, dependsOn으로 결과가 흐르는 방식), 목표 우선, 실행·복구(retry/amend/send/cancel)·감독 방법, 메인 대화가 할 수 있는 일
- `references/planning.md`: 분해 원칙(TOPOLOGY LOCK, split first, 팬아웃·팬인), 카테고리 사다리, 엣지가 나르는 데이터와 쓰기 범위, 실행 합성, 노드 프롬프트 계약(TASK / DELIVERABLE / SCOPE / VERIFY / STOP WHEN), 검증 웨이브, 실패 대응

mod는 이 스킬을 강제와 연결합니다. 프로토콜과 거부 메시지가 스킬을 안내하고, strict에서는 스킬을 불러오기 전까지 첫 계획을 거부하며, `start`와 `amend` 결과의 `warnings`가 계약을 점검합니다. 노드 프롬프트에 `TASK:`나 `STOP WHEN`이 없거나, 노드가 둘 이상인데 검증 노드(id·label·요약에 verify/check/test/review/audit가 있고 다른 노드에 의존)가 없으면 경고합니다. 경고는 실행을 막지 않습니다.

## 결과 전달

- 노드는 최종 보고서를 `## Output` 섹션(만든 파일, 핵심 사실·값·결정)과 `DAG_NODE_STATUS` 줄로 끝내도록 지시받습니다.
- 노드가 끝나면 전체 보고서는 `.claude/dag/runs/<run_id>/<node>.md`에 저장되고, 출력(`## Output` 섹션, 없으면 보고서 전체)은 상태에 기록됩니다.
- 하위 노드의 프롬프트에는 `dependsOn`에 적힌 직접 의존 노드들의 출력(노드당 4,000자까지)과 전체 보고서 경로가 `<upstream_results>`로 자동으로 들어갑니다. 정의의 `goal`은 모든 노드에 전달됩니다.
- 메인 대화는 노드마다 출력 발췌가 담긴 짧은 진행 알림을 받고, 정착하면 모든 노드의 출력과 보고서 경로가 담긴 요약을 받습니다.

## 정의 형식

```yaml
key: review-fan-in          # 멱등 키: 같은 키+같은 정의로 다시 시작하면 기존 실행을 돌려줌
name: Integration review
goal: Find and confirm wiring bugs before the release
nodes:
  - id: navigation
    category: quick
    prompt: Audit src/navigation for dead routes. Write findings to notes/navigation.md.
  - id: gate-wiring
    prompt: |
      Check that every feature gate in src/gates is wired.
      Write findings to notes/gates.md.
  - id: verify
    dependsOn: [navigation, gate-wiring]
    prompt: Read notes/*.md and verify each finding against the code.
```

| 필드 | 설명 |
| --- | --- |
| `id` | 1-64자의 영문, 숫자, `_`, `-`, `.` |
| `prompt` | 혼자 읽어도 이해되는 작업 지시 |
| `goal` (정의 수준) | 전체 목표. 모든 노드 프롬프트에 들어갑니다 |
| `dependsOn` | 먼저 완료돼야 하는 노드 id. 이 노드들의 출력이 프롬프트에 자동으로 들어갑니다 |
| `category` | 모델 라우팅: `quick`=haiku, `unspecified-low`/`deep-low`/`writing`/`visual-engineering`=sonnet, `unspecified-high`/`deep-high`/`artistry`/`ultrabrain`/`architect`=opus. 없으면 세션 모델 |
| `agent` | 서브에이전트 타입(예: `Explore`). 기본값 `general-purpose` |
| `label`, `task_summary`, `description` | 패널 표시용 |
| `load_skills` | 노드가 시작 전에 불러올 스킬 이름 |

YAML은 DAG 정의에 필요한 부분집합만 지원합니다(매핑, 시퀀스, 인용 문자열, `[a, b]`, `|`/`>` 블록 스칼라, 주석). `{a: 1}` 형태의 플로우 매핑은 지원하지 않습니다.

## 실행 규칙

- 의존 노드가 모두 `completed`인 노드가 `scheduled`가 되고, 실행 수 상한(기본 8)까지 동시에 시작됩니다.
- 노드가 실패하거나 취소되면 그 하위 노드는 `skipped`가 됩니다. 관계없는 노드는 계속 실행됩니다.
- 노드 상태는 서브에이전트 턴 종료 이유로 정합니다. `aborted`면 `cancelled`, `error`/`refusal`이면 `failed`이고, 답변 마지막 줄이 `DAG_NODE_STATUS: failed: <이유>`여도 `failed`입니다.
- 실행이 끝나면 세션에 "완료 주장은 증거로 확인하기 전까지 거짓으로 취급하라"는 지침과 함께 요약 메시지가 들어갑니다.

### `dag` 도구 액션

| 액션 | 동작 |
| --- | --- |
| `start {definition}` | 시작. 같은 키와 같은 정의면 기존 실행 재사용, 다른 정의면 `definition_conflict`. 결과에 계약 점검 `warnings` 포함 |
| `snapshot {run_id}` / `list` | 상태 조회(노드 답변 발췌 포함) |
| `wait {run_id}` | 현재 스냅샷 반환. Claude Code에서는 hook이 10초 넘게 기다릴 수 없어서 블로킹하지 않습니다 |
| `cancel {run_id, reason}` | 대기 중 노드는 취소, 실행 중 노드 에이전트는 TaskStop으로 중단 |
| `retry {run_id, node_id\|node_ids, prompt}` | 실패/취소 노드와 그 때문에 skip된 하위 노드를 다시 실행. 완료 노드는 재사용 |
| `amend {run_id, definition}` | 노드 fingerprint(prompt, category, agent, dependsOn)를 비교해 바뀐 노드와 그 하위 노드만 다시 실행 |
| `send {run_id, node_id, message}` | 실행 중인 노드에 메시지를 보내 방향을 바꿈 |
| `attach {run_id}` | 다른 세션의 실행을 이 세션으로 가져와 남은 노드를 이어서 실행 |

## DAG 패널

위상 정렬한 레이어, 노드 상태, 의존 관계, 노드 카드를 보여 줍니다. 실행 중인 노드는 모델 활동(`⏳ waiting for model`, `💭 thinking`, `✎ now`, `▶ Bash running`)을 표시합니다. 토큰 없이 30초, 첫 토큰 없이 90초가 지나면 `⚠ possibly stalled`로 표시합니다.

첫 웨이브 다음에 시작되는 노드는 Claude Code가 스트리밍 이벤트를 mod에 전달하지 않습니다. 그래서 이런 노드의 활동은 2초마다 노드 기록을 읽어 메시지 단위로 표시하고, stall 경고는 모델 대기가 5분을 넘을 때만 띄웁니다.

| 키 | 동작 |
| --- | --- |
| Tab / Enter | 노드 선택 / 카드 펼치기·접기(선택은 저장됨) |
| `h` / `l` | 이전 / 다음 실행 |
| `d` | 상세 보기(task id, 답변) |
| `t` | DAG 뷰와 Tasks 뷰(DAG에 속하지 않은 서브에이전트) 전환 |
| Esc | 프롬프트로 돌아가기(`/dag`로 연 패널은 닫힘) |

패널을 직접 닫으면 자동으로 다시 열리지 않습니다. `/dag`로 다시 엽니다.

## 설정

`/config`의 플러그인 항목에서 바꿉니다.

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `language` | `en` | 패널 언어(`en`, `ko`) |
| `max_concurrent` | `8` | 실행 하나에서 동시에 도는 노드 수 |
| `retention_days` | `14` | 시작 시 다른 세션의 오래된 종료 실행 체크포인트 삭제. `0`이면 보관 |
| `node_messages` | `compact` | 노드 서브에이전트가 `SubagentHandback`으로 메인 세션에 보내는 보고서 처리. `compact`는 짧은 진행 알림으로 바꾸고(전체 보고서는 실행 스냅샷에 보관), `full`은 그대로 둡니다 |

## omo와 다른 점

- `wait`은 블로킹하지 않습니다. 대신 정착 알림이 세션을 깨웁니다.
- 이미 끝난 노드를 `send`로 다시 깨우지는 못합니다. `retry`에 `prompt`를 주어 다시 실행합니다.
- 세션이 끝나면 서브에이전트도 끝납니다. 그래서 `claude -p`처럼 비대화형 세션에서는 이 세션이 시작한 실행이 정착할 때까지(최대 60분) 메인 턴을 끝내지 않고 붙잡아 둡니다. 같은 세션을 재개하면 실행 중이던 노드는 다시 시작하고, 다른 세션의 실행은 `attach`로 가져옵니다.
- 첫 웨이브 다음에 시작되는 노드는 Claude Code가 그 노드의 도구 호출과 스트리밍 이벤트를 mod에 전달하지 않습니다(2.1.287 기준). 그래서 그 노드들은 활동을 기록 기반으로 표시하고, 답변과 `DAG_NODE_STATUS`는 완료 뒤 기록에서 회수합니다. 메인 세션으로 가는 보고서도 `compact`로 줄어들지 않고 전체가 갑니다.

## DAG 형태 평가

`eval/`은 이 플러그인이 실제로 다양한 DAG 형태를 만드는지 측정하는 하네스입니다. 각 시나리오는 작은 고정 파일과 DAG를 언급하지 않는 평범한 작업 문장, 결과 확인 명령으로 이루어져 있고, 특정 토폴로지를 유도하도록 골랐습니다.

| 시나리오 | 기대 형태 |
| --- | --- |
| `single-edit` | 단일 노드 |
| `parallel-files` | 독립 병렬 |
| `map-reduce-docs` | 팬아웃 → 팬인 |
| `pipeline-stats` | 체인 |
| `diamond-app` | 다이아몬드 |
| `debug-fix` | 조사 → 수정 → 검증 체인 |
| `wide-harvest` | 샤딩 팬아웃 → 집계 |
| `research-write` | 조사 병렬 → 작성 |

```bash
bun eval/run.ts --list
bun eval/run.ts [--only id,id] [--concurrency 4] [--model sonnet] [--timeout-min 15] [--keep]
```

러너는 시나리오마다 `/tmp/dag-shapes/<stamp>/<id>`에 고정 파일을 만들고 `claude -p --plugin-dir <이 저장소>`를 실행합니다(현재 계정의 사용량을 씁니다). 끝나면 체크포인트의 정의로 노드 수, 깊이, 레이어 폭, 팬인 노드, 검증 노드, 경고, 카테고리, 형태(전체와 검증 노드를 뺀 생산자 형태)를 측정하고, 세션 기록에서 스킬 로드가 start보다 먼저였는지와 거부 횟수를 확인하며, 결과 확인 명령을 실행합니다. 결과는 `eval/results/<stamp>.md`와 `.json`에 저장되고, 고정 파일 디렉터리는 `--keep`이 없으면 지워집니다.

## 개발

```bash
claude plugin validate .
claude plugin test
bunx -p typescript@5 tsc -p . --noEmit
```

엔진 로직은 `hooks/engine/`, 패널 모델은 `hooks/ui/`에 `$`를 쓰지 않는 순수 함수로 있습니다. mods API 호출은 모두 `hooks/register.ts`에 있습니다.
