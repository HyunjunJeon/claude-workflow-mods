# dag-workflow 개선 백로그
Run key: improve-discover-1
기준 커밋: ec65b71, 작성일: 2026-10-20

## 근거 출처
- runs: `.claude/dag/runs/*.json` 10건(이 탐색 실행 제외)의 체크포인트, 라우팅, 모델, 시간, 검증 기록을 읽었다. 후보 6건, 확인 6건. 공백: 일부 재시도 노드는 검증 JSON이 없어 재시도 원인을 결정 로그로 추정했고, 시도별 소요 시간은 저장되지 않는다.
- eval: `eval/baselines/*.md` 10건의 표와 Findings를 읽었다(`claude -p`는 실행하지 않음). 후보 7건, 확인 7건. 공백: `eval/results/*.json`이 없어 수치는 모두 baseline 표에서 가져왔고, 4분 타임아웃 행은 이미 고쳐진 것으로 제외했다.
- learned: 학습 스킬 9건의 현재 HEAD 반영 여부를 코드로 분류했다. 후보 3건, 확인 3건. 공백: 모든 스킬의 사용 횟수가 0이라 실제 효용은 판단할 수 없고, 테스트는 실행하지 않았다.
- health: `claude plugin test`(1343 pass / 0 fail), `claude plugin validate`, tsc, git 수정 이력을 읽었다. 후보 4건, 확인 4건. 공백: 실패/스킵 테스트가 없어 테스트 후보는 없고, hunk 헤더는 `register()` 내부 핸들러를 구분하지 못한다.
- docs: README, `docs/reference.md`, `AGENTS.md`, `hooks/AGENTS.md`, `plugin.json`, `register.ts`, `i18n.ts`를 대조했다. 후보 4건, 확인 4건. 공백: 앵커 검사는 slug 근사이고, `plugin.json` 범위 값과 `register.ts` clamp는 비교하지 않았으며, `skills/*/SKILL.md`는 목록만 보았다.
- flows: `flows/improvement/*.yaml` 13건을 `bun eval/check-definition.ts`로 검사하고 실행 로그를 읽었다. 후보 4건, 확인 3건, 반박 1건. 공백: review-standards가 규칙 파일 누락 시 어떻게 동작하는지는 실제 실행 없이 확인하지 못했다.

합계: 후보 28건, 확인 27건, 반박 1건, 미확인 0건.

## 우선순위
등급 기준: 영향 H=성공으로 보고된 잘못된/미검증 결과 또는 사용자 작업·상태 손실, M=실행 실패, 수동 수정·재시도 필요, 또는 사용자/에이전트가 오도됨, L=느림·잡음·외관. 근거 수=독립 관찰 수(정의, 베이스라인, 로그 묶음 단위). 비용 S=모듈 1개와 테스트, M=2~4개 모듈, L=`hooks/register.ts` 기능 횡단 배선 또는 신규 기능. 정렬은 영향, 근거 수(많은 순), 비용(낮은 순)이다.

| 순위 | ID | 개선 항목 | 영향 | 근거 수 | 비용 | 근거 후보 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | B1 | 병렬 레인의 넓어진 타입 소비자와 wave 끝 tsc 게이트 지침 | M | 5 | M | FLOW-4 |
| 2 | B2 | 문서/등록 표면의 드리프트 정리 | M | 4 | M | DOCS-1, DOCS-2, DOCS-3, DOCS-4 |
| 3 | B3 | 검증 check 정밀도 lint (`contains`/`absent`) | M | 3 | S | RUN-5, LEARN-1 |
| 4 | B4 | eval 점수와 카운터의 정확도 | M | 3 | S | EVAL-1, EVAL-2, EVAL-3 |
| 5 | B5 | lint 경고의 오탐과 확인 불가 문제 | M | 3 | M | FLOW-2, FLOW-3, HEALTH-3 |
| 6 | B6 | Jev 라우팅/복구 기준을 분리 | M | 2 | M | RUN-1, RUN-2 |
| 7 | B7 | 게이팅 훅의 `.catch` 부재 | M | 1 | S | HEALTH-2 |
| 8 | B8 | review-fix 생략 위험을 정의 작성 시점에 경고 | M | 1 | S | LEARN-2 |
| 9 | B9 | 리뷰 요청이 존재하지 않는 산출물을 지목하는 문제 | M | 1 | S | EVAL-7 |
| 10 | B10 | eval 반복 실행(`--repeat`) | M | 1 | M | EVAL-4 |

## 항목
### B1. 병렬 레인의 넓어진 타입 소비자와 wave 끝 tsc 게이트 지침
- 문제: 병렬 레인은 전체 스위트나 tsc 검사를 가질 수 없어 file-checks-only로 우회하는데, 한 레인이 타입을 넓히면 다른 레인의 소비자가 깨져도 아무도 소유하지 않는다. 정의를 쓰는 에이전트와 실행하는 사용자가 겪는다.
- 근거: FLOW-4 - `skills/planning/references/planning.md`에 widened type 소비자와 wave 끝 tsc 게이트 언급이 없다(grep 결과 없음). 우회가 p4, p6, p7, p8, p11에 5건, 타입 합집합 메모가 p7, p8, p10에 3건, p10은 `board-chips.ts`의 tsc 실패로 기록되었다. file-checks-only 우회 자체는 의도된 것이다(`p4:28-30`, 마지막 노드가 전체 스위트를 돌린다).
- 영향 / 비용: M, 실제로 한 실행이 tsc에서 실패했다 / M, `skills/planning/references/planning.md`, `skills/planning/SKILL.md`, 필요하면 wave 끝 check 지원.
- 방향: 타입을 넓히는 레인이 소비자 파일을 소유하거나, wave 뒤에 tsc 노드를 두라는 지침을 추가한다. 선택적으로 lint가 타입 변경 레인 뒤의 join 부재를 경고한다.
- Draft goal: Add planning guidance, and a lint warning if feasible, so that a definition whose parallel lane widens a shared type assigns its consumers to an owner or a post-wave tsc gate, observable as the guidance text and a test that flags a definition without either.
- 결정할 것: (1) 지침만 추가할까, lint 경고까지 넣을까? 권장: 지침과 lint 경고를 함께 넣되 경고는 비차단으로 한다. (2) wave 끝 tsc는 별도 노드 관례로 둘까, 정의 필드로 만들까? 권장: 관례로 둔다(새 필드는 비용 L).

### B2. 문서/등록 표면의 드리프트 정리
- 문제: `AGENTS.md`가 존재하지 않는 `skills/dag-planning/`을 가리켜 에이전트가 길을 잃고, `/dag` 인자 힌트가 8개 하위 명령을 숨기며, 설정 표와 명령 목록에 누락이 있다.
- 근거: DOCS-1 - `AGENTS.md:23`, `:33`이 `skills/dag-planning/`을 쓰지만 실제는 `skills/planning/`이며 트리에는 배포 스킬 8개 중 1개만 있다. DOCS-2 - `hooks/register.ts:3704`의 argumentHint가 view, inspect, context, note, decisions, sessions, handoff, accept를 빠뜨리고 `register.ts:75`의 `USAGE`와 `docs/reference.md:28-52`에는 있다. DOCS-3 - `plugin.json:156`의 `main_allowed_tools`가 `docs/reference.md` 설정 표에 없다(`:115` 산문에만 있음). DOCS-4 - `register.ts:3037`이 명시적 `/dag open`을 처리하지만 문서에 없다.
- 영향 / 비용: M, 에이전트와 사용자가 잘못된 경로/힌트에 오도된다(DOCS-4는 L) / M, `AGENTS.md`, `hooks/register.ts`, `docs/reference.md`.
- 방향: 경로를 고치고 스킬 목록을 채우며, argumentHint를 `USAGE`와 같은 목록에서 만들고, 설정 표에 행을 추가하고, `open`을 별칭으로 문서화한다.
- Draft goal: Fix the documentation and registration drift so that AGENTS.md names skills/planning/, the /dag argument hint is built from the same list as USAGE, docs/reference.md lists main_allowed_tools with default [], and /dag open is documented, observable as a test that compares the hint with USAGE and a grep that finds no skills/dag-planning/ path.
- 결정할 것: (1) argumentHint를 `USAGE` 목록에서 생성할까, 수동으로 고칠까? 권장: 생성한다. (2) `/dag open`은 별칭으로 문서화할까, 명시 verb를 제거할까? 권장: 문서화한다(제거는 호환성을 깨뜨린다).

### B3. 검증 check 정밀도 lint (`contains`/`absent`)
- 문제: 노드가 알 수 없는 정확한 문장을 `contains`로 요구하면 첫 시도가 실패하고, 넓은 `absent`는 작업이 보존하라고 한 텍스트에도 걸려 영원히 통과하지 못한다. 사전 경고가 없다.
- 근거: RUN-5 - `fix-main-turn.verification.1.json`(contains 문장이 `tests/b6-hold.test.ts:301`로 옮겨져 미발견)과 `ab-prep.verification.1.json`(`commit --amend` 미발견), 첫 시도 검증 실패 2건 모두 해당. `hooks/engine/lint.ts:144-160`은 criterion 표현만 본다. LEARN-1 - `hooks/engine/check-eval.ts:30-32`가 파일 전체에 `text.indexOf(expect.absent)`를 쓰고 `lint.ts`에 absent 경고가 없으며, `dag-learned-verify-check-precision/SKILL.md:7`이 실제 사례를 기록한다.
- 영향 / 비용: M, 노드가 실패하고 재시도가 필요하다 / S, `hooks/engine/lint.ts`와 `tests/lint.test.ts`.
- 방향: 작업 문구에 없는 긴 정확 문장을 인용하는 `contains`와, 파일 전체를 훑는 넓은 `absent`를 정의 작성 시 경고한다.
- Draft goal: Make lintDefinition warn when a file check quotes a long exact sentence that the node task text does not repeat or uses a broad absent string over a whole file, observable as new cases in tests/lint.test.ts that pass.
- 결정할 것: (1) 경고로 둘까, start를 거부할까? 권장: 경고로 둔다(오탐 가능성). (2) "긴 문장"의 기준은? 권장: 공백 포함 40자 이상이고 task 텍스트에 없는 경우.

### B4. eval 점수와 카운터의 정확도
- 문제: strict 강제에서는 shape 일치 점수가 8/8에 도달할 수 없고, 시작 수와 거부 수가 `tool_use` id가 아니라 transcript 행 수라 부풀며, 거부 열에는 도구/규칙 구분이 없다. baseline 비교가 오도된다.
- 근거: EVAL-1 - `eval/run.ts:194`는 `direct` 시나리오를 실행 목록이 비었을 때만 센다. `eval/baselines/board-surface-baseline.md:11`이 strict는 두 `direct` 시나리오를 항상 1노드 DAG로 돌린다고 쓰고 `:39`가 6/8 대 5/8을 보인다. EVAL-2 - `run.ts:108-118`이 id 집합 없이 블록마다 1을 더하고 `board-surface-baseline.md:46-48`은 starts=2인데 고유 id 1개인 세션 5건을 보인다. EVAL-3 - `eval/report.ts:41`이 단일 `toolDenials` 카운터만 증가시키며 거부 열을 가진 baseline 8건 모두 0이 아니다.
- 영향 / 비용: M, 사용자가 잘못된 수치에 오도된다 / S, `eval/run.ts`, `eval/report.ts`(`eval/scenarios.ts` 가능).
- 방향: strict에서 1노드면 `direct`를 일치로 채점하고, `tool_use` id로 중복을 제거하며, 거부를 도구와 이유로 나눠 보고한다.
- Draft goal: Fix the eval scorer so that a direct scenario counts as matched when strict enforcement produces one node, starts and refusals are deduplicated by tool_use id, and the refusal column is split by tool and reason, observable as a unit test over a fixture transcript with duplicated rows.
- 결정할 것: (1) 기존 baseline 표를 새 규칙으로 다시 계산해 덧붙일까, 다음 baseline부터 적용할까? 권장: 다음 baseline부터 적용하고 변경을 기록한다(실모델 실행 비용 때문). (2) 거부 분류 단위는 도구와 규칙 중 어느 쪽인가? 권장: 도구와 거부 이유 문자열 두 열.

### B5. lint 경고의 오탐과 확인 불가 문제
- 문제: 의도된 수직 슬라이스가 "one producer owns N files" 경고 때문에 `check-definition`에서 FAIL로 끝나고 확인할 방법이 없으며, `review.request` criterion 경고는 이미 동작을 말하는 절을 지적한다. 규칙 계수 로직은 한 달에 여러 번 고쳐졌다.
- 근거: FLOW-2 - p4, p6, p11이 FAIL을 출력하고(p5는 재실행 안 함) p7은 헤더의 기대와 달리 OK를 출력한다. `skills/planning/references/planning.md:168`이 이미 경고를 기대된 것으로 설명하므로 문제는 `eval/check-definition.ts`가 1로 종료하는 점이다. FLOW-3 - `hooks/engine/lint.ts:141`이 단독 "a/an", "and a"를 산출물 시작으로 보고 `:144` 단어 목록에 "updates", "gets"가 없어 p6, p11에서 경고가 난다. HEALTH-3 - `lint.ts`를 고친 수정 커밋 7건(9af16ca, e0a1f14, a9fc661, 700e6d1, 564f3e7, ea807ff, 53fb06d) 중 계수 수정은 4건이다.
- 영향 / 비용: M, 도구가 정상 정의를 FAIL로 표시해 사용자를 오도한다 / M, `hooks/engine/lint.ts`, `eval/check-definition.ts`, `tests/lint.test.ts`.
- 방향: 정규화된 경로 집합(폴더, 파일, 표기)을 한 번 계산해 표로 테스트하고, 노드가 슬라이스임을 선언하면 OK와 메모를 출력하며, 단독 관사를 산출물 시작으로 보지 않는다.
- Draft goal: Rework lintDefinition so that it computes one normalized path set, lets a node declare itself a single vertical slice so check-definition prints OK with a note, and no longer treats a bare article as a deliverable start, observable as check-definition output for p4, p6 and p11 and a table-driven test in tests/lint.test.ts.
- 결정할 것: (1) 슬라이스 선언 문법은? 권장: 노드 필드 `slice: true`(주석이 아니라 파서가 보는 값). (2) 경고를 FAIL 종료 코드에서 제외할까? 권장: 선언된 슬라이스만 제외한다.

### B6. Jev 라우팅/복구 기준을 분리
- 문제: 하나의 공유 `jev_confidence` 0.9가 노드 라우팅 답변 대부분을 버리고(그중 정의와 다른 최상위 선택이 있다), 복구도 Jev가 0.9 미만이면 implementation이 최상위여도 수동으로 넘어가 한 노드가 시도 5까지 갔다.
- 근거: RUN-1 - 저신뢰 라우팅 결정 72건 중 27건이 정의와 다른 최상위 선택이다(`dec.py` 출력 "72 27"). `plugin.json`에 공유 `jev_confidence` 0.9 하나뿐이고 mode만 `hooks/engine/jev.ts:137`의 `MODE_CONFIDENCE`=0.8을 가진다. RUN-2 - 복구 결정 6건 중 3건이 수동이고 implementation은 0.53, 0.81, 0.57이다. `hooks/engine/recovery.ts:9`의 `MAX_AUTO_RECOVERIES`=2와 `:40`의 `recovery_exhausted`, 실행 파일에서 `request-lint`는 `"attempt": 5`다.
- 영향 / 비용: M, 수동 개입과 재시도가 필요하다 / M, `.claude-plugin/plugin.json`, `hooks/register.ts`, `hooks/engine/jev.ts`, `hooks/engine/recovery.ts`.
- 방향: 라우팅과 복구에 각각 별도 기준을 두거나, 적용되지 않은 최상위 선택을 화면에 드러낸다. 복구는 더 낮은 기준으로 자동 재시도 1회를 허용한다.
- Draft goal: Give node routing and recovery their own configurable Jev confidence bars so that a recovery decision whose top class is implementation at 0.5 or higher starts one automatic retry, observable as a recovery test that no longer returns manual and a plugin.json option for each bar.
- 결정할 것: (1) 기본 기준값은? 권장: 라우팅 0.8(`MODE_CONFIDENCE`와 동일), 복구 0.5. (2) 기준 미달 시 최상위 선택을 알림으로 보일까? 권장: 예, 한 줄 알림. (3) 자동 복구 상한 2를 유지할까? 권장: 유지한다.

### B7. 게이팅 훅의 `.catch` 부재
- 문제: `prompt.submit`, `session.receive`, `tool.check`가 저장소 읽기/쓰기를 `await`하면서 가드가 없어, 예외 하나가 사용자 턴을 거부하거나 알림을 잃게 할 수 있다.
- 근거: HEALTH-2 - `claude plugin validate`가 "gating hook without .catch" 11줄(with 3)을 출력한다. `hooks/register.ts:3782-3791`(`session.receive`가 `refreshSessions`를 가드 없이 await), `:3860-3913`(`prompt.submit`이 `persistContext`, `decideTurn`, `collectLearning`을 가드 없이 await), `:3937`(`tool.check`가 `markWaiting`을 await하고 `:676`의 `$.clock.now()`가 `try` 밖). 나머지 8개 훅은 확인하지 않았다.
- 영향 / 비용: M, 사용자 턴 실패 또는 알림 손실 가능 / S, `hooks/register.ts`와 `tests/runtime.test.ts`.
- 방향: 기록 후 `next(e)`로 통과하는 `.catch`를 추가하되, `decideTurn`이 던질 때의 의도된 닫힌 게이트는 유지한다.
- Draft goal: Add a catch that logs and falls through to next(e) to the prompt.submit, session.receive and tool.check hooks while keeping the deliberately closed gate when decideTurn throws, observable as runtime tests where an injected store failure no longer rejects the user turn.
- 결정할 것: (1) 나머지 8개 훅도 이 단계에 포함할까? 권장: 아니오, 먼저 3개만 하고 검사 결과로 판단한다. (2) 실패를 사용자에게 알릴까 로그만 남길까? 권장: 로그만 남긴다.

### B8. review-fix 생략 위험을 정의 작성 시점에 경고
- 문제: 생산자의 id, label, task_summary에 외부 작업 단어(`delet`, `commit` 등)가 있으면 review-fix 라운드가 그 생산자를 건너뛴다. 사유는 settle 메시지에 나오지만 정의를 쓸 때는 알 수 없다.
- 근거: LEARN-2 - `hooks/engine/rework.ts:25`의 접두사 목록과 `:36-40`의 `rerunRisk`가 생략 사유를 반환하고, `hooks/engine/lint.ts`는 `rerunRisk`/`externalWord`를 쓰지 않는다.
- 영향 / 비용: M, 수정 라운드가 자동으로 시작되지 않아 수동 수정이 필요하다 / S, `hooks/engine/lint.ts`와 `tests/lint.test.ts`.
- 방향: lint가 `rerunRisk`를 재사용해 검토 대상 생산자의 이름에 외부 작업 단어가 있으면 경고한다.
- Draft goal: Make lintDefinition reuse rerunRisk from hooks/engine/rework.ts to warn when a producer feeding a review node has an id, label or task summary that would make the review-fix round skip it, observable as a lint test that reports the producer and the matching word.
- 결정할 것: (1) 경고만 할까, 이름 변경을 제안할까? 권장: 경고에 사유와 이름 변경 제안을 함께 담는다. (2) `review.*` 노드가 없는 정의도 검사할까? 권장: 아니오.

### B9. 리뷰 요청이 존재하지 않는 산출물을 지목하는 문제
- 문제: 리뷰 요청이 "Finally write report.md"라고 말하지만 리뷰어는 초안 파일을 판단하여 불일치가 생긴다.
- 근거: EVAL-7 - `eval/baselines/git-fixtures-rerun.md` Findings, `eval/scenarios.ts`의 `pipeline-stats` 프롬프트가 아직 `report.md`를 지목한다. 이전 p0/rerun 실패는 `hooks/engine/lint.ts:13`이 이미 막는다. 관찰은 `git-fixtures-rerun` 1건뿐이다.
- 영향 / 비용: M, 리뷰어가 의도와 다른 파일을 판단한다 / S, 생성된 리뷰 요청과 `eval/scenarios.ts`.
- 방향: 리뷰 요청이 초안 파일을 산출물로 명시하거나, 시나리오 산출물 이름을 바꾼다.
- Draft goal: Make the generated review request name the draft file as the deliverable it judges, or rename the pipeline-stats scenario deliverable, observable as a test where the review request text contains the actual file name and not report.md.
- 결정할 것: (1) 생성 문구를 고칠까, 시나리오를 고칠까? 권장: 생성 문구를 고친다(다른 정의에도 적용). (2) 근거가 1건뿐인데 지금 진행할까? 권장: 예, 비용이 S이기 때문이다.

### B10. eval 반복 실행(`--repeat`)
- 문제: baseline은 시나리오당 1회 실행이라 shape 변화가 계획기 노이즈와 구분되지 않는다.
- 근거: EVAL-4 - `eval/run.ts`에 `--repeat`이 없다. `board-surface-baseline.md:33-34`에서 diamond-app이 3노드 팬아웃으로 갔다가 diamond로 돌아가고, `speed-fixes-ab.md:46`은 거의 매번 다른 shape를 쓴다고 기록한다. baseline 10건 중 8건이 시나리오당 1회다.
- 영향 / 비용: M, 사용자가 우연한 차이를 효과로 오해한다 / M, `eval/run.ts`, `eval/report.ts`, `eval/shape.ts`.
- 방향: `--repeat k`를 추가하고 일치율과 시간 분포를 보고한다.
- Draft goal: Add a --repeat k option to eval/run.ts that runs each scenario k times and reports the shape match rate and time spread per scenario, observable as a unit test over recorded fixtures and the new report columns.
- 결정할 것: (1) 기본 k는? 권장: 기본 1, 비교 시 3. (2) 사용량 상한을 둘까? 권장: 예, `--repeat`가 3을 넘으면 확인 플래그를 요구한다.

## 그 밖의 후보
- RUN-6: 검사는 통과했으나 환경 테스트가 실패한 노드가 실행을 failed로 끝내고 수용 경로가 없음(단일 관찰, `recovery.ts`/`verification.ts`의 수용 경로는 추적하지 않음). 영향 M, 근거 1, 비용 M.
- RUN-3: review-fix 재실행이 변경 없는 생산자를 다시 돌림(`rework.ts`의 `findingShares`, `reworkPlan`, 재시도 10건 중 2건, 원인 추정). 영향 L, 근거 2, 비용 M.
- RUN-4: trivial/low 노드가 수 분 걸려도 범주 대비 느림 신호가 없음(`parse.py`: trivial 9건 중앙값 165초, 최대 378초; UI 코드는 확인하지 않음). 영향 L, 근거 2, 비용 M.
- EVAL-5, EVAL-6: 실패 경로(검토 실패, 통과 불가 check) 시나리오가 없고 review/commit 단계 사용이 채점되지 않음(`eval/scenarios.ts`, `eval/shape.ts`). 영향 L, 근거 2, 비용 M.
- HEALTH-1: `hooks/register.ts`가 4337줄이고 `register()` 클로저가 수정의 대부분을 받음(2026-09-01 이후 수정 커밋 20건). 영향 L, 근거 1, 비용 L.
- HEALTH-4: `.claude-plugin/marketplace.json`에 description이 없고 README에 설치 줄이 없음(`claude plugin validate` 경고). 영향 L, 근거 1, 비용 S.
- LEARN-3: 에이전트가 읽는 텍스트가 모두 영어여야 한다는 규칙이 어떤 저장소 안내에도 없음(`AGENTS.md:80`과 `skills/planning/SKILL.md:93`만 부분 언급). 영향 L, 근거 1, 비용 S.

## 기각한 후보
- FLOW-1 (반박): `hooks/engine/stages.ts:212`가 "A listed file that does not exist is recorded under ## Rule sources as missing and does not end the node"라고 처리하므로 누락된 규칙 경로는 조용하지 않다. `AGENTS.md` 3건이 없는 것은 맞지만, 낡은 `skills/dag-*` 쓰기 경로는 끝난 p1-p3 정의에만 있어 현재 피해가 재현되지 않는다.
- 미확인(UNCHECKED): 없음.

## 다음 단계
1. 항목을 고르고 각 항목의 "결정할 것"에 답한다.
2. 고른 항목마다 계획 원칙에 따라 `flows/improvement/p<N>-<slug>.yaml`을 작성한다. goal은 Draft goal을 쓰고, 답변은 헤더의 Q 줄로 적고, review와 commit 필드를 포함한다.
3. `/dag run`으로 실행한다. 모델의 계획 방식이 바뀌는 변경이면 `flows/improvement/eval-rerun.yaml`을 새 키로 다시 돌려 비교한다.
4. `flows/improvement/discover.yaml`을 새 키로 다시 돌려 무엇이 달라졌는지 확인한다.
