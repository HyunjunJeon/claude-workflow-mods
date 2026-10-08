# 개선 계획: 검증 증거력 · 계획 지침 · 시작 전 정렬

작성 2026-10-08. 근거: [mattpocock/skills](https://github.com/mattpocock/skills)(MIT), [Q00/ouroboros](https://github.com/Q00/ouroboros)(MIT), 이 저장소의 코드.

## 목표

1. `verify`가 **실패할 수 있는 검사**인지 기계적으로 잡는다(두 출처가 따로 지적한 같은 결함).
2. 계획 지침(`planning.md`)에 검증 웨이브·분해·디버그 패턴을 더한다.
3. DAG 시작 전 요구사항 정렬(인터뷰·PM)을 strict 모드 제약 안에서 지원한다.

ouroboros의 MCP 장치(lane, fanout id, submit 호출)는 가져오지 않고 원칙만 가져온다.

## 기준선 (2026-10-08)

- 테스트 305 통과 / 0 실패, `tsc` 통과, `claude plugin validate .` 통과(경고만)
- 미커밋: 15개 파일(Jev 병렬 라우팅, 최종 감사 규칙), `tests/tool-spec.test.ts`, `docs/`, `.claude-plugin/marketplace.json`(신규)
- eval: `parallel-files` 1개 시나리오만 측정(2회). `eval/results/`는 gitignore 대상이라 기준선 요약은 이 문서의 진행 기록에 남긴다.
- 설치: `dag-workflow@claude-dag-workflow`, user 범위, 이 저장소 폴더에서 직접 읽음(수정 후 `/reload-plugins`로 반영)

## 먼저 정할 것

| ID | 질문 | 추천 | 이유 |
| --- | --- | --- | --- |
| D1 | 이 저장소 작업을 DAG 노드로 할지(dogfooding), 개발 세션만 `/dag enforce guide`로 할지 | dogfooding, 막히면 guide | 플러그인 자체의 사용성 결함을 직접 발견한다. 디렉터리 마켓플레이스 설치라 노드가 `lint.ts`를 고쳐도 실행 중인 플러그인은 리로드되지 않는다. 실행 중에는 `/reload-plugins`를 하지 않는다 |
| D2 | 빈 검증을 경고만 할지, 모든 검사가 빈 노드는 거부할지 | 1단계는 경고 | 기존 lint는 모두 경고다. 거부는 기존 정의 파일을 깨뜨릴 수 있으니 eval에서 오탐 0을 확인한 뒤 검토한다 |
| D3 | 디버그 체인에서 "재현 명령"을 수정 노드의 `verify`로 넘기는 방법 | (a) 지금, (b) 후속 | `verify`는 `start` 시점에 고정된다. (a) 진단 run → 수정 run 두 번(“한 run = 한 단계”와 일치). (b) 선언한 재현 스크립트 경로 + command 검사가 실패(비0 종료)를 기대하는 스키마 확장 — `verification.ts`, `register.ts:804` 변경 |
| D4 | mattpocock 스킬을 쓰는 방법 | (b) | (a) `mattpocock-skills` 플러그인 설치 + `load_skills: ["mattpocock-skills:<name>"]` — 외부 설치에 의존하고 사용자 확인 단계가 노드 안에서 막힌다. (b) 필요한 부분만 이 플러그인의 스킬로 발췌(MIT 고지 포함), 노드는 `load_skills: ["dag-workflow:<name>"]` |
| D5 | 두 축 리뷰 노드를 각각 끝 노드로 둘지, 집계 노드를 더할지 | 각각 끝 노드 | mattpocock은 두 축을 섞어 재순위하지 않는다. 정착 요약이 이미 모든 노드 출력을 나란히 전달하고, 최종 감사 규칙으로 둘 다 `unspecified-low` 이상이 된다 |

## Phase 0 — 준비 (약 1시간 + eval 10–20분)

1. 미커밋 변경 커밋(사용자 승인 후).
2. eval 기준선: `bun eval/run.ts --concurrency 4`로 8개 시나리오 전체. 사용자 계정 사용량을 쓴다. 요약을 아래 진행 기록에 옮긴다.
3. D1–D5 결정.
4. 공유 문서 "AIL 해부도" 접근 확보 → Phase 2 입력으로 반영.

## Phase 1 — 빈 검증 lint (약 1–2시간)

파일: `hooks/engine/lint.ts`, `tests/policy.test.ts`(기존 `lintDefinition` 테스트 위치), README 검증 섹션, `planning.md` 검증 문단.

노드마다 해당하는 검사 번호를 모아 경고 하나로 낸다(경고 폭주 방지). 메시지는 기존 lint처럼 영어.

| 규칙 | 조건 | 경고 요지 |
| --- | --- | --- |
| V1 | `{kind: file}`에 `contains` 없음 | 존재만 확인한다. `touch`로도 통과한다 |
| V2 | command `argv[0]`(basename)가 `true`, `:`, `echo`, `printf`, `exit`, `yes`, `sleep` | 항상 통과한다 |
| V3 | `test`/`[`가 `-e`/`-f`/`-d`/`-s`만 쓰거나, `ls`/`stat`/`cat`만 실행 | 존재만 확인한다 |

범위 밖: `sh -c '…'` 같은 셸 래퍼 내부 분석.

수용 기준:
- 규칙마다 양성·음성 테스트 1개씩
- 기존 테스트 전부 통과, `tsc`, `validate`
- eval 결과의 warnings 열을 기준선과 비교

## Phase 2 — 계획 지침 (약 3–4시간 + eval 재실행)

파일: `skills/dag-planning/references/planning.md`, `skills/dag-planning/SKILL.md`, 새 노드용 스킬(D4-b).

**2a. 검증 웨이브의 두 축 템플릿** (code-review)
- `review-spec`: goal과 요청 대비 (a) 누락·부분 구현 (b) 요청하지 않은 동작(범위 초과) (c) 구현됐지만 틀려 보이는 것. 항목마다 요청 문장을 인용한다.
- `review-standards`: 저장소 규칙 파일(CONTRIBUTING, CLAUDE.md 등) + Fowler 코드 스멜 기준(항상 판단 사항으로 표시, 저장소 규칙이 우선).
- 코드 변경이 있는 실행에만 적용한다. 문서·조사 실행은 기존 단일 검증 노드를 유지한다(오버헤드).

**2b. "안전하지만 틀린 산출물" 점검표 → 최종 감사 프롬프트 필수 항목** (ouroboros)
- 산출물 종류가 요청과 같은가(CLI를 요청했는데 문서만 만들지 않았는가)
- 새 입력으로 다시 실행할 수 있는가
- 빠진 데이터가 OK·0·빈 값으로 표시되지 않았는가
- 검증이 동작을 증명했는가, 파일 존재만 증명했는가
- 미달이면 "완료"가 아니라 `partial/supporting-output`으로 보고한다

**2c. 분해 규칙** (to-tickets)
- 산출물 단위 분할은 그대로 두고, 기능 작업의 단위를 "끝까지 관통하는 수직 슬라이스"로 정의한다.
- 넓은 리팩터는 expand → 영향 범위별 migrate 배치 → contract 체인으로 둔다.

**2d. 디버그 체인** (diagnosing-bugs, D3-a)
- 진단 run: "이미 한 번 실패를 확인한 재현 명령 1개"(빠르고 결정적이며 증상 자체를 확인)와 반증 가능한 가설 3–5개를 Output에 남긴다.
- 수정 run: 그 명령을 `verify`에 넣는다.
- 디버그 로그는 `[DEBUG-xxxx]` 태그를 쓴다. 제거 확인은 지금 스키마로 표현할 수 없다(일치 없음 = 비0 종료) → B2에서 해결.

**2e. 노드용 스킬 발췌** (D4-b)
- 후보: 진단 노드용(diagnosing-bugs), `review-standards`용 스멜 기준(code-review), 구현 노드용 좋은 테스트·안티패턴(tdd에서 "사용자와 테스트 지점 합의" 단계는 뺀다).
- `THIRD_PARTY_NOTICES.md`에 MIT 고지를 남긴다.
- 먼저 노드 1개짜리 실행으로 `load_skills: ["dag-workflow:<name>"]`이 노드 안에서 해석되는지 확인한다.

수용 기준:
- `validate`
- eval 8개 재실행 결과를 기준선과 비교: 형태 일치 수, 검증 노드 비율, 경고 수, 노드 수, 실행 시간(2a로 늘어나는 노드·시간을 기록)

## Phase 3 — 시작 전 정렬: 인터뷰·PM (약 1–1.5일)

strict 모드 제약: 메인은 `AskUserQuestion`, Read, 읽기 전용 Bash만 쓸 수 있다. Agent와 Write는 쓸 수 없다.

**3a. 코드: 비대화형 플래그**
- `protocolFor(level, interactive)`에 "비대화형 세션: 사용자에게 묻지 말고, 가정을 goal과 노드 프롬프트에 적는다"를 추가한다(`policy.ts:276`, `register.ts:1716`, `interactive`는 `register.ts:1544`에서 이미 설정됨). 테스트 포함.
- `eval/run.ts`에 `AskUserQuestion` 호출 수 열을 추가한다.

**3b. 코드: `goal` 누락 lint 경고** (`lint.ts`. Phase 1과 같은 파일이라 순서대로 진행)

**3c. 스킬 `skills/dag-interview/SKILL.md`** (사용자 호출 전용, `/dag-workflow:dag-interview`)
- 설계 트리 라운드(grilling): 지금 답할 수 있는 질문을 모두 묻는다. 질문마다 번호와 추천 답을 달고, "yes"는 추천 수락. `AskUserQuestion` 한 번에 최대 4개.
- 모호성 목록(ouroboros): 범위·제약·산출물·검증 네 트랙을 보이게 유지해 한 트랙으로 쏠리지 않게 한다.
- 사실 vs 결정: 사실은 Read·`rg`·읽기 전용 Bash로 직접 찾고, 큰 조사는 읽기 전용 노드 1개짜리 DAG로 한다. 결정만 사용자에게 묻는다. 사용자가 아닌 답이 3번 연속이면 다음 질문은 사용자에게 간다.
- Refine: 사용자 말(user-stated)과 내 해석을 구분해 표시한다.
- 종료(Restate gate): 한 문장 goal과 수용 기준 목록을 사용자에게 확인받은 뒤 dag-planning으로 넘긴다(goal → `definition.goal`, 수용 기준 → `verify` 후보).

**3d. 스킬 `skills/dag-pm/SKILL.md`** (사용자 호출 전용)
- 질문을 셋으로 분류한다: 제품 결정(묻기), 기술 결정(개발 단계로 미룸), 모름(나중에 결정 → 열린 항목).
- PRD 파일은 메인이 쓸 수 없으므로 `write-prd` 노드 1개짜리 DAG가 쓴다(verify: 파일 + `## Open items`).

**3e. dag-planning 정렬 단계**
- 산출물 종류·범위·수용 기준 중 하나가 실제로 모호할 때만 질문 1라운드를 한다. 비대화형이면 생략한다.

수용 기준:
- 테스트, `tsc`, `validate`
- eval 8개에서 `AskUserQuestion` 0회(3a 동작 확인)
- 인터뷰는 `claude -p`로 측정할 수 없으므로 tmux 수동 점검 1회: 모호한 요청 → 질문 라운드 → goal 확인 → `start`

## 순서

```
P0 ─▶ P1 ─▶ P2 ─▶ eval 재실행 ─▶ P3a ─▶ P3b ─▶ P3c ─┬▶ P3e
                                                    └▶ P3d
```

P3a는 P1 이후 언제든 가능하다(다른 파일). P3b는 `lint.ts`를 같이 고치므로 P1 다음에 둔다.

## 실행 정의

| Phase | 파일 | key | 노드 수 | 실행 |
| --- | --- | --- | --- | --- |
| P0 | `flows/improvement/p0-eval-baseline.yaml` | `improve-p0-eval-baseline-1` | 7 | `/dag run flows/improvement/p0-eval-baseline.yaml` |
| P1 | `flows/improvement/p1-vacuous-verify.yaml` | `improve-p1-vacuous-verify-1` | 5 | `/dag run flows/improvement/p1-vacuous-verify.yaml` |
| P2 | `flows/improvement/p2-planning-doctrine.yaml` | `improve-p2-planning-doctrine-1` | 12 | `/dag run flows/improvement/p2-planning-doctrine.yaml` |
| P3 | `flows/improvement/p3-alignment.yaml` | `improve-p3-alignment-1` | 9 | `/dag run flows/improvement/p3-alignment.yaml` |

- 파일은 D2–D5의 추천안을 전제로 쓰였다. 다른 결정을 내렸다면 실행 전에 해당 파일을 고친다.
- P2 뒤의 eval 재실행은 `p0-eval-baseline.yaml`을 새 key로 다시 쓴다.
- P0의 커밋, 결정(D1–D5), 공유 문서 접근은 사용자가 직접 하는 일이라 노드가 없다.

## 이번 주기 밖 (백로그)

| ID | 항목 | 출처 | 규모 |
| --- | --- | --- | --- |
| B1 | 노드 첫 시도 전에 file 검사를 실행해, 이미 통과하면 "증거력 없음"으로 기록 | ouroboros evidential-force RFC | 0.5–1일 |
| B2 | command 검사의 실패 기대(`expectExit`) — 실패 확인과 부재 확인(`rg` 일치 없음) | D3-b | 0.5일 |
| B3 | 노드별 worktree 격리(`$.agent.spawn`의 `cwd`) + merge 노드. `writes`를 실제 격리로 바꾼다 | implement-spec | 1–2일 |
| B4 | split-first vs "원자적 시도 후 근거 있을 때만 분할" — eval의 노드 수·시간으로 측정한 뒤 지침 결정 | ouroboros decomposition RFC | 측정 0.5일 |
| B5 | 노드·실행별 토큰 사용량(`turn.complete`의 usage)을 패널·요약에 표시 | API 조사 | 0.5–1일 |

## 진행 기록

| Phase | 상태 | 날짜 | 메모 |
| --- | --- | --- | --- |
| P0 | 대기 | | |
| P1 | 대기 | | |
| P2 | 대기 | | |
| P3 | 대기 | | |
