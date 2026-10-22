# 개발 안내

[README로 돌아가기](../README.md)

모든 명령과 코드 경로는 저장소 루트 기준입니다.

## 개발

```bash
bash scripts/ci.sh
command claude plugin validate .
command claude plugin test .
bunx -p typescript@5 tsc -p . --noEmit
semgrep --test --metrics off --config skills/secure-coding/rules tests/semgrep
```

마지막 줄은 Semgrep 시큐어코딩 규칙의 테스트이며 semgrep이 설치되어 있어야 합니다. `tests/semgrep/`의 각 픽스처에서 `ruleid:` 주석이 달린 줄은 규칙이 잡아야 하고 `ok:` 주석이 달린 줄은 잡으면 안 됩니다. 결과가 한 건도 없는 규칙을 semgrep 1.181은 "ruleid annotation with no YAML rule"로 보고하므로, 그 메시지는 규칙 이름 오타보다 패턴이 아무것도 잡지 못한 경우를 먼저 의심합니다. 플러그인 테스트(`tests/secure-scan.test.ts`)는 semgrep 대신 스텁을 씁니다.

`bash scripts/ci.sh`는 `claude --version`, 플러그인 검증과 테스트, `--allow-warnings`를 붙인 흐름 정의 검사(린트 경고는 출력만 하고 실패시키지 않음), Semgrep 규칙 테스트, `.claude-plugin/types/`가 있을 때의 tsc를 차례로 돌리며 첫 실패에서 멈추고 `ci: all checks passed`로 끝납니다. semgrep이 없으면 로컬에서는 안내 메시지를 남기고 그 단계를 건너뛰지만 `CI=true`에서는 실패합니다. `.github/workflows/ci.yml`은 main 푸시, 풀 리퀘스트, 수동 실행마다 ubuntu-24.04(ubuntu-latest가 Ubuntu 26으로 옮겨 가는 중이라 고정)에 Claude Code 2.1.307(npm의 `@anthropic-ai/claude-code`), bun 1.4.3, Python 3.12, semgrep 1.181을 설치해 이 스크립트를 실행합니다. tsc는 CI에서 돌리지 않고 로컬에서만 돌립니다. `.claude-plugin/types/`는 gitignore 대상으로 Claude Code가 플러그인을 불러올 때 쓰는 폴더이고, 그 안의 `claude-code-tools/index.d.ts`가 세션의 도구 스키마에서 나오기 때문입니다(스텁으로는 2026-10-22에 오류 18건이 났습니다). 2.1.307의 테스트 키트는 `$.tool.call`이 세션과 같은 방식으로 도구 권한을 그 안에서 검사하므로(플러그인의 `tool.call` 훅, `classic.PreToolUse`, 호출 시점의 `tool.check` 순서이고 `ask`는 물어볼 사람이 없어 거부됩니다), 테스트는 거부된 호출을 `result.isError`와 엔진의 거부 문구로 확인합니다. CI의 Claude Code를 올리려면 새 버전에서 `bash scripts/ci.sh`를 로컬로 먼저 통과시킨 뒤 워크플로의 버전 변수를 바꿉니다.

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

러너는 `enforcement`를 지정하지 않아 기본값 `auto`로 돕니다. 기대가 "DAG 없이 직접 실행"(`eval/scenarios.ts`의 `expect: 'direct'`)인 시나리오는 Jev가 작은 요청으로 판단해 DAG 실행이 하나도 만들어지지 않을 때만 일치로 세고, 결과 표의 형태 열에는 `no run`이 나옵니다.


```bash
bun eval/run.ts --list
bun eval/run.ts [--only id,id] [--concurrency 4] [--model sonnet] [--timeout-min 15] [--keep] [--enforcement strict]
```

러너는 시나리오마다 `/tmp/dag-shapes/<stamp>/<id>`에 고정 파일을 만들어 첫 커밋 하나가 있는 git 저장소로 초기화하고 `claude -p --plugin-dir <이 저장소>`를 실행합니다(현재 계정의 사용량을 씁니다). 생성되는 검토 노드(`review-spec`, `review-standards`)가 `git diff`로 변경을 읽기 때문입니다. 머리말에 `Fixtures: git repositories with one initial commit.`이 없는 결과(스탬프 `20261010113334`까지)는 git 저장소가 아닌 고정 파일에서 측정한 것입니다. 끝나면 체크포인트의 정의로 노드 수, 깊이, 레이어 폭, 팬인 노드, 검증 노드, 경고, 카테고리, 형태(전체와 검증 노드를 뺀 생산자 형태)를 측정하고, 세션 기록에서 스킬 로드가 start보다 먼저였는지와 거부 횟수를 확인하며, 결과 확인 명령을 실행합니다. 결과는 `eval/results/<stamp>.md`와 `.json`에 저장되고, 고정 파일 디렉터리는 `--keep`이 없으면 지워집니다. `--enforcement <수준>`은 `--settings`의 `pluginConfigs`로 그 실행의 `enforcement`를 정합니다. 기본값이 `auto`가 된 뒤로는 작은 시나리오가 직접 실행될 수 있으므로, `strict`에서 찍은 기준선과 비교할 때는 `--enforcement strict`를 줍니다. 머리말에 `Enforcement: strict.`가 붙습니다.

결과 표의 `AskUserQuestion calls` 열(`refusals (planning/tools)` 바로 뒤)은 시나리오 세션 기록의 메인 대화에서 `AskUserQuestion` 도구를 호출한 횟수입니다(서브에이전트 호출은 세지 않습니다). `claude -p`는 비대화형 세션이라 프로토콜이 사용자에게 묻지 말라고 알리므로 기대값은 0이고, 0보다 크면 모델이 물으려 했다는 뜻입니다. 사용자의 답이 있어야 하는 인터뷰(`interview`, `pm`)는 `claude -p`로 측정할 수 없습니다.
