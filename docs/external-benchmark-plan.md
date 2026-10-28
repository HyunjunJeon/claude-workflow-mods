# 외부 비교 개선 계획: Claude Code 2.1.290–2.1.312 · Herdr · Orca

작성 2026-10-28. 기준: 브랜치 `fix/host-2-1-311-permission-gate`(`9d20a4e`), 설치된 Claude Code 2.1.312, Orca CLI 1.4.240.
`docs/improvement-plan.md`(P12–P15)와 함께 쓰는 작업 문서다. 그 계획은 이 저장소 안의 결함을, 이 문서는 외부에서 새로 생긴 기능과 다른 도구의 설계를 다룬다. 끝나면 지운다.

## 출처

| 출처 | 읽은 범위 | 비고 |
| --- | --- | --- |
| Claude Code 변경 이력 (`code.claude.com/docs/en/changelog`) | 2.1.290–2.1.312 | 2.1.287–2.1.289는 페이지가 잘려 읽지 못했다. 2.1.297–2.1.298은 버전 표기가 없는 구간에 섞여 있다 |
| 호스트 타입 선언 (`.claude-plugin/types/claude-code/index.d.ts`) | 아래 항목의 API 시그니처 | 변경 이력의 내용이 설치된 호스트에 실제로 있는지 확인했다 |
| Herdr (`herdr.dev/agent-guide.md`, `/docs/socket-api/`, `/docs/integrations/`, GitHub README) | 상태 감지, wait, 이벤트, Claude 통합 | 이 컴퓨터에 설치되어 있지 않다 |
| Orca (`orca --help`, `orca skills get orchestration`) | Run/Task/Dispatch, 작업자 의무, 결정 게이트 | 로컬 1.4.240 바이너리에서 읽었다 |

## 요약

1. **이미 반영됨:** `turn.start`의 서브에이전트 이벤트 분리(`hooks/register.ts:4211`), 마지막 줄 상태 계약(`DAG_NODE_STATUS`, Orca의 `--outcome`과 같은 원칙), 시간 기준 멈춤 표시(`hooks/ui/activity.ts:68`).
2. **바로 쓸 수 있는데 안 쓰는 호스트 API:** `$.ui.notify`, `$.ui.view({ agentId })`, `$.model.complete`의 `cache: true`, `tool.register`의 `isDeferred`, `tool.check`의 `isReadOnly`. 사용 횟수는 모두 0이다.
3. **동작이 바뀐 호스트 API:** 2.1.301부터 mod의 `.catch`는 훅이 예외를 던지거나 시간을 넘길 때만 실행된다(P12 `hook-guards`에 영향). 2.1.292·2.1.300부터 Workflow 에이전트도 `agent.spawn` 훅을 지나고 프롬프트를 바꿀 수 있다(아래 A2). `Text`의 `bold`는 2.1.299에서 `weight`로 대체 예정(deprecated)이 됐다.
4. **설계 차이:** Orca 작업자는 실행 중에 조정자에게 막는 질문(`ask`)을 할 수 있고, Herdr는 "막힘"을 판정한 근거를 `agent explain`으로 보여 준다. 이 플러그인의 노드는 질문할 길이 없어 추측하거나 `failed`로 끝난다.

## 후보

판정: **채택**(단계에 넣음) · **조사**(설계 문서만) · **보류** · **해당 없음**.

### 호스트 API (Claude Code)

| ID | 버전 | 내용 | 이 저장소 현황 | 판정 |
| --- | --- | --- | --- | --- |
| A1 | 2.1.301 | `.catch`는 훅이 던지거나 시간을 넘길 때만 실행 | P12 D6이 이 의미를 전제로 하는지 확인되지 않았다. `validate`의 "without .catch" 11건도 이 기준으로 다시 세야 한다 | 채택 → P12에 흡수 |
| A2 | 2.1.292, 2.1.300 | Workflow 에이전트가 `agent.spawn` 훅을 지나고 prompt·model을 다시 쓸 수 있음 | `on('agent.spawn')`(`hooks/register.ts:3916`)가 학습 스킬 목록을 모든 생성 프롬프트에 붙인다. `e.workflow`를 확인하지 않으므로 Workflow 에이전트에도 붙는다 | 채택 → P12에 흡수 |
| A3 | 2.1.295 | `$.ui.notify(text, { title })`: 터미널 밖 알림 채널. `isSent`가 false면 toast로 대체 | 알림은 toast·notice·band 9곳뿐이라 터미널을 보고 있지 않으면 놓친다 | 채택 → X1 |
| A4 | 2.1.300 | `$.ui.view({ agentId })`: 에이전트의 대화 기록을 보여 줌 | 인스펙터(`hooks/ui/inspector-*.ts`)는 노드 상태와 출력만 보여 준다 | 채택 → X1 |
| A5 | 2.1.292 | `$.model.complete` 블록에 `cache: true` | Jev 세션 모델 백엔드(`hooks/register.ts:766`)는 같은 system 프롬프트를 매번 보낸다 | 보류 (2026-10-28, X2 참고) |
| A6 | 2.1.293 | `tool.register`의 `isDeferred: false`: 스키마를 처음부터 프롬프트에 둠 | `dag`·`board` 도구는 지연 로딩이라 첫 사용마다 ToolSearch 왕복이 필요하다. 대신 모든 턴에 스키마 토큰이 든다 | 보류 (2026-10-28, X2 참고) |
| A7 | 2.1.304 | `tool.check`의 `e.isReadOnly`, `decider: "person"` | `policy.ts`가 읽기 전용 도구를 자체 목록으로 분류한다. 호스트 값과 어긋날 때를 알 수 없다 | 완료 (X3) |
| A8 | 2.1.299 | `Text.bold` → `weight` | `bold` 90곳, 20개 파일(테스트 포함) | 완료 (X3) |
| A9 | 2.1.305 | 고정(docked) 패널 너비가 터미널의 45% 이하로 제한 | 레이아웃은 너비를 받지만 45% 폭 사례를 테스트하는지는 확인하지 않았다 | 완료 (X3, 테스트만) |
| A10 | 2.1.300 | `prompt.change` + `virtualText`: 입력 중 장식 | 라우팅 결과(DAG/보드/직접)를 입력 중에 미리 보여 줄 수 있지만 입력할 때마다 Jev를 부르면 비용이 든다 | 보류 |
| A11 | 2.1.299 | `$.session.identity()` | 세션 레지스트리·인계 잠금이 sessionId만 쓴다. 이점이 확인되지 않았다 | 보류 |
| A12 | 2.1.302, 2.1.311 | prompt/agent 훅 동시 실행 상한(이벤트당 12, 세션 24) | 이 플러그인은 settings 훅이 아니라 mod 훅과 `$.model.complete`를 쓴다 | 해당 없음 |

### Herdr

| ID | 내용 | 이 저장소 현황 | 판정 |
| --- | --- | --- | --- |
| H1 | 상태를 `working`/`blocked`/`done`/`idle`/`unknown`로 나누고, `agent explain --json`이 판정 근거(규칙, 대체 사유)를 보여 줌 | 패널은 `⚠ possibly stalled`만 보여 준다. 세 임계값(`STALL_WAIT_MS`, `STALL_TOKEN_MS`, `STALL_COARSE_MS`) 중 무엇에 걸렸는지 알 수 없다 | 채택 → X1 (인스펙터에 근거 한 줄) |
| H2 | 에이전트가 답을 기다리면 알림 | 권한 대기는 toast·status·band로만 알린다(`hooks/register.ts:694`) | 채택 → X1 (A3로 구현) |
| H3 | `agent.wait`가 대상 pane의 현재 점유자를 고정해, 교체된 에이전트가 기다림을 끝내지 못하게 함 | 같은 원칙(재시도한 노드에 이전 시도의 종료 이벤트가 섞이지 않음)이 `agentRuns`로 구현되어 있으나 회귀 테스트가 있는지 확인하지 않았다 | 완료 (X3, 테스트만) |
| H4 | `herdr integration install claude`가 `SessionStart` 훅을 설치하고, Claude 상태는 화면을 읽어 판정 | 고정 패널과 band가 화면을 바꾸므로 Herdr의 화면 판정이 틀릴 수 있다 | 조사 → X5 |

### Orca

| ID | 내용 | 이 저장소 현황 | 판정 |
| --- | --- | --- | --- |
| O1 | 작업자가 조정자에게 막는 질문(`orchestration ask`)을 보내고 답을 받아 이어감. 결정 게이트(`gate-create`)가 태스크를 막음 | 노드는 질문할 수 없다. 범위가 모호하면 추측하거나 `failed`로 끝나고, 사람이 amend한다 | 완료 (X4 설계 → `aaacbbe`, `docs/design/node-questions.md`) |
| O2 | 태스크마다 별도 worktree(`worker-start --worktree`)와 `worktree ps` 요약 | 모든 노드가 한 작업 트리를 공유하고, lint가 파일이 겹치지 않게 막는다. 호스트 에이전트 정의에는 `isolation: 'worktree'`가 있고 `$.agent.spawn`은 `cwd`를 받는다 | 보류 (X4, `docs/design/node-isolation.md`의 다시 볼 조건) |
| O3 | 정산된 작업자를 같은 터미널에서 이어 쓰기(reuse), 보존(retain), 해제(release) 중 하나로 반드시 처리 | review-fix 라운드는 생산자를 새로 띄워 맥락을 다시 읽힌다. 끝난 에이전트는 `$.session.send({ to: { agentId } })`로 같은 id로 재개된다(2026-10-28 헤드리스 확인) | 보류 (O1의 재개 경로로 붙일 수 있음, `docs/design/node-questions.md`) |
| O4 | 태스크 명세: Target / Change / Constraints / Ownership / Observable acceptance | TASK / DELIVERABLE / SCOPE / VERIFY / STOP WHEN이 같은 역할을 한다. "건드리지 말 것"은 SCOPE 안에 섞여 있다 | 보류 (근거 1건) |
| O5 | 원격 호스트, SSH, 모바일, 예약 자동화 | 이 플러그인의 범위 밖 | 해당 없음 |

## 단계

`docs/improvement-plan.md`의 원칙을 따른다. 모든 단계는 직렬로 실행하고, 정의 파일은 단계 직전에 쓴다.

### P12에 흡수 (A1, A2)

- `hook-guards` 노드 프롬프트에 2.1.301의 `.catch` 의미를 넣는다. 각 게이트 훅에서 실패 시 기본 동작(통과/거부)을 호스트 타입 주석으로 확인한 뒤 고친다.
- `agent.spawn` 훅이 `e.workflow`일 때 학습 목록을 붙일지 결정한다(D-X1). 결정에 맞는 런타임 테스트 하나.
- 수용 기준에 "without .catch 경고 수를 2.1.312 `validate` 출력으로 다시 셈"을 추가한다.

### X1 — 주의 끌기 (A3, A4, H1, H2)

| 노드 | 범주 | 파일 | 내용 |
| --- | --- | --- | --- |
| `notify` | standard | `hooks/register.ts`, `.claude-plugin/plugin.json`, `tests/runtime.test.ts` | 실행 정산, 노드 권한 대기, 자동 복구 포기 때 `$.ui.notify`. `isSent`가 false면 지금처럼 toast. 설정 `notify`(D-X2) |
| `transcript` | standard | `hooks/ui/inspector-client.ts`, `hooks/ui/inspector-model.ts`, `hooks/ui/i18n.ts`, `tests/inspector.test.ts` | 선택한 노드의 `agentId`로 `$.ui.view` 열기. 끝난 노드, 시작 못 한 노드의 경우 구분 |
| `stall-reason` | standard | `hooks/ui/activity.ts`, `hooks/ui/view-model.ts`, `hooks/ui/i18n.ts`, `tests/activity.test.ts` | 멈춤 판정이 어느 임계값에서 나왔는지와 마지막 활동 시각을 인스펙터에 한 줄로 표시. 판정 자체는 바꾸지 않음 |
| `reference-doc` | writing | `docs/reference.md`, `README.md` | 알림 설정, 인스펙터 동작 |
| 생성 3종 | | | `review-spec`, `review-standards`, `commit` |

수용 기준:
- `mock`에서 `ui.notify`가 거부될 때 toast로 대체되는 테스트
- 새 문자열이 영어·한국어 모두에 있음(`tests/activity.test.ts`, `tests/inspector.test.ts`가 이미 `i18n`을 import하므로 그 테스트에 추가)
- `claude plugin test`, `tsc`, `validate` exit 0

### X2 — 비용과 지연 (A5, A6)

- `jev-cache`: 보류(2026-10-28). Jev의 system 프롬프트(`hooks/engine/jev.ts`의 `MODEL_SYSTEM`)는 612자, 약 150토큰이다. 캐시 표시는 그 블록까지의 앞부분을 캐시하는데, 앞에 붙는 CLI 신원 블록을 더해도 모델의 최소 캐시 크기(1,024토큰 이상)에 한참 못 미친다. 호스트 타입 설명대로 이런 표시는 아무것도 캐시하지 않으므로(`cache_creation_input_tokens`·`cache_read_input_tokens` 모두 0) 코드를 바꾸지 않았다. 질문 부분(`prompt`)은 요청마다 달라 캐시할 수 없다. system이 최소 크기를 넘게 커지면 다시 본다.
- A6: 보류(2026-10-28). `dag` 도구만 `isDeferred: false`로 둔 변경과 D8을 같은 명령(strict 강제, 시나리오당 2샘플, 16세션)으로 비교했다(`eval/baselines/d8-a6-baseline.md`). ToolSearch 호출은 2회에서 0회로 줄었다. 첫 `dag start`까지 시간 중앙값은 24초에서 25초, 메시지당 입력 토큰 중앙값은 55,114에서 58,210(+5.6%), 세션당 입력 토큰 중앙값은 553,557에서 549,685였다. shape 일치는 13/16에서 15/16이다. 없애는 왕복이 드물고 모든 턴이 스키마 토큰을 내므로 보류한다. ToolSearch 왕복이 흔해지면 다시 본다.

### X3 — 호스트 API 정리 (A7, A8, A9, H3) — 완료

- `bold-weight`(trivial, 기계적): `bold: true` → `weight`. 트리 비교 테스트를 함께 갱신. 파일이 20개라 lint 파일 수 경고가 날 것이므로 D4의 `slice: true`를 쓴다.
- `readonly-crosscheck`(standard): `policy.ts`의 분류와 `e.isReadOnly`가 다를 때 debug 로그와 판단 기록. 동작은 바꾸지 않고 한 단계 관찰한 뒤 정한다.
- `layout-45`(trivial): 대표 터미널 폭의 45% 너비 사례를 `tests/views.test.ts`·`tests/graph.test.ts`에 추가.
- `stale-end`(trivial): 재시도한 노드가 이전 시도의 `agent.end`로 정산되지 않는 회귀 테스트. 이미 있으면 노드를 지운다.

### X4 — 설계 조사 (O1, O2, O3), 읽기 전용 — 완료

산출물: `docs/design/node-questions.md`, `docs/design/node-isolation.md`. 코드는 바꾸지 않는다.

- **O1 노드 질문:** 마지막 줄 `DAG_NODE_STATUS: blocked: <question>`을 새 상태로 받을지, `dag` 도구에 노드용 `ask` 액션을 둘지 비교한다. 답은 사용자가 패널·보드 승인 블록에서 하거나 Jev가 한다. 답을 받은 뒤 같은 에이전트를 이어 쓸 수 있는지(호스트 API), 없으면 새 시도에 질문과 답을 넣는지 정한다. Orca의 "질문 시간 초과 뒤에는 같은 메시지 ID로 이어감"을 참고한다.
- **O2 노드 격리:** (a) `isolation: 'worktree'` 에이전트 정의를 플러그인이 배포, (b) 플러그인이 `git worktree add` 후 `$.agent.spawn({ cwd })`. 병합 순서, 충돌 시 처리, review-spec이 볼 diff, 검증 명령의 실행 위치, 정리 시점을 비교한다. 2.1.311에서 고쳐진 "백그라운드 서브에이전트가 쓰는 worktree 삭제" 버그는 (a)의 위험 근거다.
- **O3 재작업 재사용:** 끝난 노드 에이전트에게 메시지를 보낼 플러그인 API가 있는지 타입 선언에서 확인하고, 없으면 보류로 기록한다.
- 검증 노드가 각 문서의 API 주장을 타입 선언의 줄 번호로 다시 확인한다.

- **결과 (2026-10-28):** 두 설계 문서(`15c0331`)를 쓴 뒤 재개 경로를 헤드리스로 두 번 확인했다(`7326234`). O1을 구현했다(`aaacbbe`). 실제 헤드리스 실행에서 질문한 노드는 `blocked`로 멈췄다. Jev가 확신도 0.88로 기준 0.9에 못 미쳐 기본값을 보냈고, 노드는 같은 에이전트·같은 시도(attempt 1)로 이어 완료됐다. O2는 보류, O3는 O1의 재개 경로를 쓸 수 있어 남은 후보다.

### X5 — 다른 도구 안에서 실행 (H4), 수동

- **상태 (2026-10-28):** 보류. 이 세션은 X4·O1·O3까지 하고 멈췄다. Herdr는 설치하지 않으므로(D-X3) 아래 Herdr 줄은 하지 않고, 다시 열면 Orca 줄만 한다.

- Orca 터미널에서 DAG 실행 하나: `orca terminal wait --for tui-idle`이 실행 중에 일찍 끝나지 않는지, 패널 너비가 맞는지.
- Herdr 안에서 같은 실행: 화면 판정이 `working`/`idle`을 맞게 보이는지. Herdr 설치가 필요하다(D-X3).
- 결과를 `README.md`의 "사용 중 알아둘 점"에 한두 줄로 적는다.

## 순서

P12(+A1, A2) → X1 → P13 → P14 → X2(D8 재측정과 함께) → P15a → P15b → X3 → X4 → X5

- **X1이 P13보다 먼저:** 사용자에게 보이는 효과가 가장 크고, `register.ts`를 고치는 P12 직후에 하면 줄 번호를 한 번만 다시 읽으면 된다.
- **X2를 D8에 붙임:** 실모델 측정을 한 번으로 줄인다.
- **X3이 P15b 뒤:** `bold` 일괄 교체는 UI 파일 전체를 건드려 다른 단계와 충돌하기 쉽다.
- **X4는 구현 전에 결정이 필요:** 설계 문서를 보고 O1·O2를 구현할지 정한다.

## 먼저 정할 것

| ID | 질문 | 추천 | 이유 |
| --- | --- | --- | --- |
| D-X1 | Workflow 에이전트 프롬프트에도 학습 스킬 목록을 붙일지 | 붙이지 않음(`e.workflow`면 `next(e)`) | Workflow 스크립트는 프롬프트를 직접 짜고, 일부 실행은 프롬프트를 자리표시자로 둬 다시 쓰기가 적용되지 않는다(타입 주석) |
| D-X2 | 알림 기본값 | 켬. 정산·권한 대기·복구 포기만 | 터미널을 떠난 사용자가 가장 자주 놓치는 세 경우. 노드 완료마다 보내면 시끄럽다 |
| D-X3 | X5를 위해 Herdr를 설치할지 | 설치하지 않음(2026-10-28 사용자 결정). X5는 Orca만 | 외부 도구 설치이고, Claude `settings.json`에 훅을 추가한다 |
| D-X4 | X4에서 O1과 O2 중 무엇을 먼저 | O1 | O2는 병합·검증·리뷰 전체를 바꾸지만, O1은 상태 하나와 응답 경로만 더한다. 지금 실패의 원인으로 더 자주 보였다 |

## 확인하지 못한 것

- Claude Code 2.1.287–2.1.289 변경 이력.
- Herdr의 Claude 통합 버전 6과 10의 관계(문서끼리 맞지 않음).
- ~~O3에 쓸 플러그인 API(에이전트에게 메시지 보내기) 존재 여부.~~ 있다: `$.session.send({ to: { agentId } })`(2026-10-28 확인).
- 대화형 세션과 `claude --resume` 뒤에도 끝난 서브에이전트가 재개되는지(헤드리스에서만 확인했다).
