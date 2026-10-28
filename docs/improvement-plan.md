# 개선 계획: 문서 정합성 · 정의 lint · eval 정확도 · Jev 기준

작성 2026-10-20. 근거: `docs/improvement-backlog.md`(실행 `dag_mvgmecok_150je7`, 기준 커밋 `ec65b71`)와 이 저장소의 코드.
작업 문서다. 모든 단계가 끝나면 이전 계획(`bc52ef4`)처럼 지운다.

## 목표

1. 에이전트와 사용자가 틀린 경로·명령 힌트에 속지 않게 하고, 훅 예외가 사용자 턴을 막지 않게 한다(B2, B7).
2. 정의를 쓸 때 실패할 검사, 수정 라운드에서 빠질 노드, lint 오탐을 미리 알린다(B1, B3, B5, B8, B9).
3. eval 수치를 믿을 수 있게 한다(B4, B10).
4. 실제 결정 기록으로 Jev 기준을 정한 뒤 바꾼다(B6).

## 기준선 (2026-10-20)

- 테스트 1343 통과 / 0 실패(64 파일), `tsc` 오류 0, `claude plugin validate .` 통과(경고: "gating hook without .catch" 11개).
- 정의 lint: `flows/improvement/` 13개 중 4개가 경고(p4, p5, p6, p11). 모두 의도한 수직 슬라이스이거나 동작을 이미 적은 요청 문장이다.
- Jev: 세 프로젝트의 routing·recovery 결정 109건은 모두 HTTP 백엔드였고 기준 0.9가 적용됐다.
- 미커밋 변경:
  - 이 세션: `docs/improvement-backlog.md`, `docs/improvement-plan.md`, `flows/improvement/discover.yaml`
  - 다른 세션(`0484eb7c`로 추정, 진행 중): `README.md`, `docs/development.md`, `eval/surface.ts`, `eval/surface-cases.ts`, `eval/surface-run.ts`, `tests/surface-eval.test.ts`

## 백로그 정정

- **B6:** 백로그는 "공유 `jev_confidence` 0.9 하나뿐"이라고 썼지만, `jev_model_routing_confidence`(기본 0.8, `.claude-plugin/plugin.json:96`)가 이미 있다. 다만 이 값은 세션 모델 백엔드에만 적용되고(`hooks/register.ts:862`), 관찰된 결정은 모두 HTTP 백엔드라 0.9가 적용됐다. 그래서 B6의 범위를 "HTTP 백엔드 routing 기준과 recovery 기준을 `jev_confidence`에서 분리"로 좁힌다. permission 기준은 그대로 둔다.
- **근거 출처의 runs 줄:** "실행 10건"이 아니라 세 프로젝트의 17건이다.

## 먼저 정할 것

| ID | 질문 | 추천 | 이유 |
| --- | --- | --- | --- |
| D1 | 다른 세션의 미커밋 작업을 어떻게 할지 | 그 세션이 끝나고 커밋한 뒤 P12 시작 | 각 단계는 `git status --short -- hooks tests skills eval README.md docs .claude-plugin`이 비어 있어야 한다. 남은 변경은 review-spec이 범위 밖 변경으로 판단해 FAIL을 낸다. surface eval은 `jev.ts`를 import하므로 P15와도 겹친다 |
| D2 | 이 세션 산출물을 커밋할지 | `discover.yaml`과 백로그·계획을 한 커밋으로 넣고, 끝나면 백로그·계획만 삭제 | 각 단계 정의가 계획을 근거로 인용한다. 이전 계획도 커밋했다가 지웠다 |
| D3 | B3 검사 정밀도 경고의 조건 | `contains`: 40자 이상이고 노드 프롬프트에 그대로 나오지 않는 문장. `absent`: `start`/`preview` 시점에 대상 파일에 그 문자열이 2번 이상 있으면 경고. 둘 다 경고만 하고 거부하지 않음 | lint 규칙은 지금까지 모두 경고였다. `absent` 조건은 학습 스킬의 실제 사례(같은 문구가 커밋 메시지에도 있었음)를 잡는다. 파일을 읽어야 하므로 순수 lint가 아니라 host 단계에서 검사한다 |
| D4 | B5 수직 슬라이스를 선언하는 방법 | 노드 필드 `slice: true`. 지문(fingerprint)에서 제외하고, 파일 수 경고 대신 note를 출력 | 지금은 헤더 주석에만 적혀 있어 도구가 알 수 없다. `label`처럼 지문에서 빼야 완료된 노드가 다시 실행되지 않는다 |
| D5 | B1을 지침만 할지, lint까지 할지 | 지침만 추가. lint는 보류 | 정의만 보고는 어느 레인이 공유 타입을 넓히는지 알 수 없다. `*types.ts` 쓰기로 추정하는 규칙은 오탐을 만들고, B5 자체가 lint 오탐을 고치는 항목이다(백로그 추천과 다름) |
| D6 | B7 범위 | `prompt.submit`, `session.receive`, `tool.check` 3개에 로그 후 `next(e)`로 통과. 사용자 알림 없음. `decideTurn` 예외 시 닫히는 게이트는 유지 | 나머지 8개는 검사하지 않았다. P12 결과를 본 뒤 다음 discover에서 다시 판단한다 |
| D7 | B9를 어디서 고칠지 | 생성되는 review-spec 템플릿(`hooks/engine/stages.ts`) | REPORT*·SUMMARY* 이름은 host가 서브에이전트 쓰기를 막아 메인이 정산 뒤에 쓴다. 이 규칙은 모든 정의에 해당하므로, 리뷰어에게 노드 초안과 Output을 판단하라고 템플릿에서 알린다 |
| D8 | eval 재측정 시점과 크기 | P15b 뒤 한 번, 시나리오 8개 × `--repeat 2`(세션 16개) | P14 수정은 다음 기준선부터 적용한다(기존 표는 다시 계산하지 않음). 한 번에 측정하면 실모델 사용량을 아낄 수 있다 |
| D9 | B6 새 기준값 | P15a 측정 결과를 보고 정함(지금은 정하지 않음) | recovery 확신도 관찰값은 0.53, 0.81, 0.57 세 건뿐이다. 근거 없이 값을 고르면 자동 재시도가 Opus 비용을 늘릴 수 있다 |

## Phase 12 — 문서 정합성과 훅 가드 (B2, B7, LEARN-3)

정의: `flows/improvement/p12-docs-guards.yaml`

| 노드 | 범주 | 파일 | 내용 |
| --- | --- | --- | --- |
| `agents-doc` | writing | `AGENTS.md` | `skills/dag-planning/` → `skills/planning/`, 배포 스킬 8개를 모두 STRUCTURE에 반영, 에이전트가 읽는 프롬프트는 영어라는 규칙(LEARN-3) |
| `reference-doc` | writing | `docs/reference.md` | 설정 표에 `main_allowed_tools`(기본 `[]`) 행, `/dag open`을 `/dag`의 별칭으로 문서화 |
| `hint-from-usage` | trivial | `hooks/register.ts`, `tests/dag-ping.test.ts` | `argumentHint`(`:3704`)를 `USAGE`(`:75`)와 같은 목록에서 생성. 두 문자열을 비교하는 테스트 |
| `hook-guards` | standard | `hooks/register.ts`, `tests/runtime.test.ts` | D6의 3개 훅. 저장소 쓰기 실패를 주입한 런타임 테스트. 같은 파일이라 `hint-from-usage` 뒤에 실행 |
| `review-spec`, `review-standards`, `commit` | (생성) | | `review: {request, rules: [AGENTS.md, hooks/AGENTS.md]}` |

수용 기준:
- `grep -rn "skills/dag-planning" AGENTS.md hooks/AGENTS.md` 출력 없음
- 인자 힌트와 `USAGE`를 비교하는 테스트 통과
- 저장소 실패를 주입해도 사용자 턴이 거부되지 않는 테스트 통과
- `validate`의 "without .catch" 11 → 8
- `claude plugin test .`, `tsc`, `validate` 모두 exit 0

## Phase 13 — 정의 lint와 리뷰 템플릿 (B5, B3, B8, B9, B1)

정의: `flows/improvement/p13-definition-lint.yaml`

`lint.ts`를 세 항목이 함께 고치므로 직렬 체인으로 둔다. 나머지 레인은 파일이 겹치지 않아 병렬로 실행한다.

| 노드 | 의존 | 범주 | 파일 | 내용 |
| --- | --- | --- | --- | --- |
| `lint-paths` | — | standard | `hooks/engine/lint.ts`, `hooks/engine/definition.ts`, `hooks/engine/types.ts`, `eval/check-definition.ts`, `tests/lint.test.ts` | B5: 정규화한 경로 집합을 한 번만 계산, D4의 `slice: true`, 관사 하나를 산출물 시작으로 보지 않음. 표 기반 테스트. 슬라이스 하나라 파일 수 경고는 예상된 것 |
| `lint-checks` | `lint-paths` | standard | `hooks/engine/lint.ts`, `hooks/register.ts`(preview/start 경고 연결), `tests/lint.test.ts` | B3: D3의 두 조건 |
| `lint-rerun-risk` | `lint-checks` | trivial | `hooks/engine/lint.ts`, `tests/lint.test.ts` | B8: `rerunRisk`(`hooks/engine/rework.ts:36`)를 재사용해, review 노드가 있는 정의에서 생산자 이름에 외부 작업 단어가 있으면 경고하고 이름 변경을 제안 |
| `flows-annotate` | `lint-paths` | trivial | `flows/improvement/p4-board.yaml`, `p5-board-interview.yaml`, `p6-board-results.yaml`, `p11-board-surface.yaml`, `p7-board-trace.yaml` | 슬라이스 노드에 `slice: true` 추가, p7 헤더의 낡은 경고 설명 정리 |
| `review-template` | — | trivial | `hooks/engine/stages.ts`, `tests/stages.test.ts` | B9: D7 문구 |
| `doctrine` | — | writing | `skills/planning/references/planning.md`, `skills/planning/SKILL.md` | B1: 공유 타입을 넓히는 레인은 그 타입을 쓰는 파일도 소유하거나, 웨이브 뒤에 tsc를 돌리는 노드를 둔다. `slice: true` 사용법 |
| `reference-doc` | — | writing | `docs/reference.md` | 정의 필드 표에 `slice`, 새 경고 3종 |
| 생성 3종 | | | | `review` + `commit`(두 커밋: `skills/planning`, 나머지) |

수용 기준:
- `bun eval/check-definition.ts flows/improvement/*.yaml`이 exit 0이고, p4·p6·p11은 note와 함께 OK
- `tests/lint.test.ts`에 각 새 경고의 양성·음성 사례
- 생성된 review-spec 프롬프트에 D7 문구가 들어 있는지 확인하는 테스트
- test, `tsc`, `validate` 모두 exit 0

## Phase 14 — eval 정확도 (B4, B10)

정의: `flows/improvement/p14-eval-accuracy.yaml`. `eval/run.ts`를 함께 고치므로 직렬로 둔다.

| 노드 | 의존 | 범주 | 파일 | 내용 |
| --- | --- | --- | --- | --- |
| `eval-scoring` | — | standard | `eval/run.ts`, `eval/report.ts`, `tests/shape.test.ts` | B4: strict에서 노드 1개면 `direct`를 일치로 채점(`eval/run.ts:194`), starts·거부 수를 `tool_use` id 기준으로 중복 제거, 거부를 도구와 이유로 분리. 중복 행이 있는 fixture로 테스트 |
| `eval-repeat` | `eval-scoring` | standard | `eval/run.ts`, `eval/report.ts`, `eval/shape.ts`, `tests/shape.test.ts` | B10: `--repeat k`(기본 1, 3을 넘으면 확인 플래그 필요), 시나리오별 일치율과 시간 범위 |
| 생성 3종 | | | | |

수용 기준:
- fixture 단위 테스트 통과, `bun eval/run.ts --list` exit 0
- 실모델은 실행하지 않음(D8)

## Phase 15 — Jev 기준 분리 (B6), 실행 두 번

새 기준값은 측정 전에는 정할 수 없어서(D9) 측정 실행과 변경 실행으로 나눈다.

**15a 측정** — `flows/improvement/p15a-jev-replay.yaml`, 읽기 전용, 산출물은 `eval/baselines/jev-threshold-replay.md`
- 세 프로젝트의 결정 기록을 다시 계산한다. 기준 0.6, 0.7, 0.8, 0.9 각각에서 routing과 recovery 중 몇 건이 적용됐을지 센다.
- recovery는 노드의 다음 시도가 성공했는지로 판단이 맞았는지를 근사한다.
- 검증 노드가 표의 수치를 원본에서 다시 센다.

**결정:** 표를 보고 routing과 recovery의 기준값을 정한다.

**15b 변경** — `flows/improvement/p15b-jev-bars.yaml`
- 파일: `.claude-plugin/plugin.json`(예: `jev_routing_confidence`, `jev_recovery_confidence`), `hooks/register.ts`(기준 선택), `hooks/engine/recovery.ts`, `docs/reference.md`, README 설정 줄, `tests/recovery.test.ts`
- 기준에 못 미친 최상위 선택은 알림 한 줄로 보여 준다.
- 자동 복구 상한 2는 유지한다.
- 끝나면 D8의 eval 재측정을 한 번 한다.

## 순서

P12 → P13 → P14 → P15a → (D9 결정) → P15b → eval 재측정 → `discover.yaml`을 새 key로 실행

- **P12가 먼저:** 모든 노드가 `AGENTS.md`를 읽으므로 틀린 경로부터 고친다.
- **P13이 P14·P15보다 먼저:** 고친 lint로 뒤 단계의 정의를 검사한다.
- **P14가 P15보다 먼저:** P15b의 효과를 고친 카운터로 측정한다.
- **모든 단계는 직렬:** 동시에 돌리면 각 실행의 리뷰어가 다른 실행의 미커밋 변경을 범위 초과로 판단한다. 파일이 겹치는 단계(P12·P13의 `docs/reference.md`, P12·P13·P15b의 `register.ts`)도 있다.
- **정의 파일은 단계 직전에 작성:** 앞 단계가 바꾼 코드의 줄 번호와 이름을 확인한 뒤 프롬프트에 넣는다.

## 보류

| 후보 | 이유 |
| --- | --- |
| HEALTH-1 `register.ts` 분리 | P12, P13, P15b가 모두 이 파일을 고친다. 그 뒤에 expand → migrate → contract 체인으로 따로 진행한다 |
| HEALTH-4 marketplace 설명과 README 설치 줄 | 설치 줄은 공개 마켓플레이스가 있어야 의미가 있다. 사용자가 공개 여부를 정한 뒤 진행한다 |
| RUN-3, RUN-4, RUN-6, EVAL-5, EVAL-6 | 근거가 1~2건이다. 다음 discover 실행에서 다시 본다 |

## 진행 기록

| 단계 | 실행 | 결과 |
| --- | --- | --- |
| discover | `dag_mvgmecok_150je7` | 후보 28 / 확인 27 / 반박 1, 백로그 10개, 감사 PASS |
| P0 (2026-10-27) | 직접 수정 | Claude Code 2.1.311 테스트 키트가 `$.tool.call`에서 권한 게이트를 직접 돌려 거부를 `{ deny }`가 아닌 `isError` 결과로 돌려준다. 손으로 게이트를 흉내 내던 테스트 12개를 새 계약에 맞췄다. `register.ts`의 백그라운드 작업 판정이 `isError`를 무시해, 거부되거나 시작에 실패한 백그라운드 호출 뒤 노드가 30분 기다리다 실패하던 문제를 고쳤다(회귀 테스트 2개). 1358 통과 / 0 실패, `tsc` 0 |
