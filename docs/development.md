# 개발 안내

[README로 돌아가기](../README.md)

모든 명령과 코드 경로는 저장소 루트 기준입니다.

## 개발

```bash
command claude plugin validate .
command claude plugin test .
bunx -p typescript@5 tsc -p . --noEmit
semgrep --test --metrics off --config skills/secure-coding/rules tests/semgrep
```

마지막 줄은 Semgrep 시큐어코딩 규칙의 테스트이며 semgrep이 설치되어 있어야 합니다. `tests/semgrep/`의 각 픽스처에서 `ruleid:` 주석이 달린 줄은 규칙이 잡아야 하고 `ok:` 주석이 달린 줄은 잡으면 안 됩니다. 결과가 한 건도 없는 규칙을 semgrep 1.181은 "ruleid annotation with no YAML rule"로 보고하므로, 그 메시지는 규칙 이름 오타보다 패턴이 아무것도 잡지 못한 경우를 먼저 의심합니다. 플러그인 테스트(`tests/secure-scan.test.ts`)는 semgrep 대신 스텁을 씁니다.

이 저장소는 anti-slop 패턴 네 가지를 일부러 씁니다. 스캐너는 로컬 `AGENTS.md`의 `anti-slop allow:` 줄로 이들을 건너뛰고, 검토 노드는 이 문단을 저장소 규칙으로 읽습니다.

- `conditional-empty-spread`: `...(x ? { k: x } : {})`는 `''`, `0`, `false`도 빼므로 `k: x`로 바꾸면 동작이 달라집니다.
- `two-pass-filter-map`: 노드 수십 개짜리 배열이라 한 번에 도는 이득이 없고, 읽기는 `filter().map()`이 더 쉽습니다.
- `open-dictionary`: `Record<string, unknown>`은 손으로 짠 파서(`definition.ts`, `yaml.ts`, `verification.ts`)의 작업 타입입니다.
- `unreasoned-assertion`: 호스트 경계의 `as`와, `noUncheckedIndexedAccess`에서 코드가 이미 범위를 확인한 조회의 `as`입니다. 검사형으로 같은 동작을 낼 수 있는 곳(스택 `pop`, 문자 조회, 두 배열 비교, 그래프 레이아웃)은 2026-10-12에 바꿨습니다.

엔진 로직은 `hooks/engine/`, 패널 모델은 `hooks/ui/`에 `$`를 쓰지 않는 순수 함수로 있습니다.  
mods API 호출은 모두 `hooks/register.ts`에 있습니다.

## DAG 형태 평가

`eval/`은 이 플러그인이 실제로 다양한 DAG 형태를 만드는지 측정하는 하네스입니다. 각 시나리오는 작은 고정 파일과 DAG를 언급하지 않는 평범한 작업 문장, 결과 확인 명령으로 이루어져 있고, 특정 토폴로지를 유도하도록 골랐습니다.


| 시나리오              | 기대 형태                |
| ----------------- | -------------------- |
| `single-edit`     | DAG 없이 직접 실행         |
| `parallel-files`  | 독립 병렬                |
| `map-reduce-docs` | 팬아웃 → 팬인             |
| `pipeline-stats`  | 체인                   |
| `diamond-app`     | 다이아몬드                |
| `debug-fix`       | DAG 없이 직접 실행         |
| `wide-harvest`    | 샤딩 팬아웃(파일 450개) → 집계 |
| `research-write`  | 조사 병렬 → 작성           |

러너는 `enforcement`를 지정하지 않아 기본값 `auto`로 돕니다. 기대가 "DAG 없이 직접 실행"(`eval/scenarios.ts`의 `expect: 'direct'`)인 시나리오는 Jev가 작은 요청으로 판단해 DAG 실행이 하나도 만들어지지 않을 때만 일치로 세고, 결과 표의 형태 열에는 `no run`이 나옵니다. `--enforcement strict`에서는 만든 실행이 모두 노드 하나이면 일치로 셉니다. `auto`의 규칙(실행이 하나도 없을 때만 일치)은 그대로입니다. 그래서 `auto`나 `--enforcement` 없이 돈 노드 하나짜리 실행은 직접 실행과 일치하지 않습니다.


```bash
bun eval/run.ts --list
bun eval/run.ts [--only id,id] [--concurrency 4] [--model sonnet] [--timeout-min 15] [--keep] [--enforcement strict|auto] [--repeat k] [--confirm-usage]
```

러너는 시나리오마다 `/tmp/dag-shapes/<stamp>/<id>`에 고정 파일을 만들어 첫 커밋 하나가 있는 git 저장소로 초기화하고 `claude -p --plugin-dir <이 저장소>`를 실행합니다(현재 계정의 사용량을 씁니다). 생성되는 검토 노드(`review-spec`, `review-standards`)가 `git diff`로 변경을 읽기 때문입니다. 머리말에 `Fixtures: git repositories with one initial commit.`이 없는 결과(스탬프 `20261010113334`까지)는 git 저장소가 아닌 고정 파일에서 측정한 것입니다. 끝나면 체크포인트의 정의로 노드 수, 깊이, 레이어 폭, 팬인 노드, 검증 노드, 경고, 카테고리, 형태(전체와 검증 노드를 뺀 생산자 형태)를 측정하고, 세션 기록에서 스킬 로드가 start보다 먼저였는지와 거부 횟수를 확인하며, 결과 확인 명령을 실행합니다. 결과는 `eval/results/<stamp>.md`와 `.json`에 저장되고, 고정 파일 디렉터리는 `--keep`이 없으면 지워집니다. `--enforcement <수준>`은 `--settings`의 `pluginConfigs`로 그 실행의 `enforcement`를 정합니다. 기본값이 `auto`가 된 뒤로는 작은 시나리오가 직접 실행될 수 있으므로, `strict`에서 찍은 기준선과 비교할 때는 `--enforcement strict`를 줍니다. 머리말에 `Enforcement: strict.`가 붙습니다.

`--repeat k`는 시나리오마다 표본을 k개 만듭니다(기본값 1). 표본 하나는 실제 `claude -p` 세션 하나이므로 k만큼 사용량이 듭니다. k가 3을 넘으면 `--repeat <k> starts <k> real claude -p sessions per scenario; pass --confirm-usage to run more than 3 repeats` 오류로 시작을 거부하며, `--confirm-usage`를 주어야 돕니다. `--repeat`에는 양의 정수만 받습니다. 표본마다 고정 파일 디렉터리가 따로 만들어집니다. 머리말에는 `Repeats: k.` 줄이 붙고, 전체 줄은 `Samples matching their expected shape: m/n.`으로 표본 수를 셉니다. 결과 표는 표본마다 한 행이며 k가 1보다 크면 시나리오 칸이 `<id> #<n>`으로 나옵니다. k가 1보다 크면 `## Across repeats` 절이 더해지며 열은 `scenario`, `matched/samples`, `shapes seen`, `seconds (min-median-max)`입니다(초 칸은 `10-20-30` 꼴).

결과 표의 `AskUserQuestion calls` 열(`refusals by tool and reason` 바로 뒤)은 시나리오 세션 기록의 메인 대화에서 `AskUserQuestion` 도구를 호출한 횟수입니다(서브에이전트 호출은 세지 않습니다). 세션 기록의 DAG 시작, `AskUserQuestion` 호출, 거부 횟수는 `tool_use` id마다 한 번만 세므로 같은 행이 중복되어도 늘지 않습니다. 거부 열은 `refusals (planning/total)`(계획 거부와 전체 거부)과 `refusals by tool and reason`(`Bash: <이유> xN` 꼴을 `; `로 이은 것, 없으면 `-`)입니다. 이 변경 전에 만든 결과(기준선 포함)는 예전 방식으로 센 값이며 다시 계산하지 않습니다. `claude -p`는 비대화형 세션이라 프로토콜이 사용자에게 묻지 말라고 알리므로 기대값은 0이고, 0보다 크면 모델이 물으려 했다는 뜻입니다. 사용자의 답이 있어야 하는 인터뷰(`interview`, `pm`)는 `claude -p`로 측정할 수 없습니다.

## 표시 방식 판단 평가

`enforcement: auto`에서 Jev는 실행 방식(`mode`)과 함께 답을 채팅과 보드 중 어디에 보여 줄지(`surface`)도 판단합니다([표시 방식 판단](reference.md#표시-방식-판단)). 이 판단은 대화형 세션에서만 묻기 때문에 위의 DAG 형태 평가로는 잴 수 없습니다. `eval/surface-run.ts`는 대화 세션 없이 Jev 요청만 보내 이 판단을 따로 잽니다.

- 요청은 런타임과 같은 `modeRequest(..., true)`로 만들고, 답은 런타임의 `parseChoices`(HTTP)와 `parseModelChoices`(모델)로 읽습니다. 판단 기준 문구를 고치면 평가에도 그대로 반영됩니다.
- 케이스는 `eval/surface-cases.ts`에 있습니다. 케이스마다 정답(`board`, `chat`, 또는 채점하지 않는 `contested`)과 묶음이 있고, 일부에는 기대 실행 방식(`expectMode`)이 붙어 있습니다. 짧은 답장 케이스는 `previousReply`의 선택지로 읽힙니다.
- 지표는 `eval/surface.ts`의 순수 함수이고 테스트는 `tests/surface-eval.test.ts`입니다. 기준값(기본 `SURFACE_CONFIDENCE`)에서의 혼동 행렬과 정밀도·재현율, 기준값 0.50-0.95 훑기, 묶음별 보드 비율, 확신도 구간별 정답률, 반복 간 일치, 표시 방식 질문을 더했을 때 실행 방식이 바뀐 표본(mode 흔들림), 실행 방식 정확도, 지연 p50·p95(5,000 ms와 8,000 ms를 넘은 수)를 계산합니다.

```bash
bun eval/surface-run.ts --list
bun eval/surface-run.ts --dry-request <case> [--backend model]   # 보낼 요청만 출력, 호출 없음
bun eval/surface-run.ts [--backend http|model] [--only id,id] [--repeat 3] [--no-drift] [--concurrency 4] [--model sonnet] [--bar 0.8]
```

- `http`(기본)는 `TYPESAFE_API_KEY`로 `api.typesafe.ai`를 부르고, `model`은 세션 모델 대체를 `claude -p`(도구 없음, effort low)로 흉내 냅니다. `model`은 OAuth 로그인을 쓰려고 `--bare`를 쓰지 않습니다. 대신 빈 `/tmp/dag-surface/<stamp>` 디렉터리에서 `--setting-sources project`로 실행하고 `CLAUDE_CODE_PLUGIN_DIRS`를 지워, 이 플러그인이 분류 호출을 다시 판단하지 않게 합니다.
- 호출 수는 케이스 × `--repeat` × 2(mode 흔들림 확인용 단독 호출)이고, `--no-drift`이면 절반입니다. 두 백엔드 모두 사용량을 씁니다.
- 결과는 `eval/results/surface-<stamp>.md`와 `.json`에 저장되고, 기준선은 `eval/baselines/surface-baseline.md`입니다.
