# 시큐어코딩 시연 키트

개발 작업을 한 뒤 KISA 시큐어코딩이 지켜졌는지 검사하는 과정을 세 막으로 보여 주는 시연 키트입니다.
Spring 사용자 API 데모 저장소를 만들고, Claude Code에 dag-workflow 플러그인을 불러와 진행합니다.

| 막 | 무엇을 보여 주나 | 검사 주체 |
| --- | --- | --- |
| 1막 개발 중 | 편집하는 순간 규칙이 잡는다 | 훅 + Semgrep 규칙 (결정적) |
| 2막 개발 후 검사 | 규칙이 못 보는 것까지 진단원들이 나눠 본다 | 보안 관점 노드 7개 + 후보별 검증 노드 (판단) |
| 3막 수정과 재검사 | FAIL이면 커밋되지 않고, 고친 뒤 다시 검사를 통과해야 커밋된다 | 리뷰 수정 라운드 + 커밋 노드 (집행) |

## 준비

```bash
brew install semgrep                                    # 또는 pipx install semgrep
examples/secure-coding/setup.sh ~/kisa-demo            # 새 디렉터리에 기준선 커밋 하나가 있는 저장소를 만든다
cd ~/kisa-demo
claude --plugin-dir <이 저장소 경로> --settings demo/settings.json
```

- `demo/settings.json`은 패널을 한국어로, 동시 실행을 12로(검토 노드 9개가 한꺼번에 돌도록), 세션 학습을 끈 상태로 엽니다.
  프로젝트 `.claude/settings.json`의 `pluginConfigs`는 플러그인에 전달되지 않으므로 `--settings`로 넘깁니다.
- `CLAUDE_CODE_PLUGIN_DIRS`로 플러그인을 이미 전역에 불러오고 있다면 `--plugin-dir`는 빼도 됩니다.
- 시연을 다시 하려면 `setup.sh`로 새 디렉터리를 만듭니다.

## 1막: 개발 중에 훅이 잡는다 (라이브, 1분 안쪽)

### 장면 1: 비밀값은 쓰기 전에 막는다 (KISA 2-6)

> src/main/java/com/example/users/DbConfig.java 파일을 아래 내용 그대로 만들어 줘.
>
> ```java
> package com.example.users;
>
> public final class DbConfig {
>     public static final String URL = "jdbc:postgresql://db.internal:5432/users";
>     public static final String DB_PASSWORD = "Winter2026!";
>
>     private DbConfig() {}
> }
> ```

Write가 `[secure-scan] Refused before writing ...: kisa 2-6 하드코드된 중요정보 [kisa-2-6-hardcoded-secret-java]`로 거부되고 파일은 생기지 않습니다.
거부 사유에는 비밀번호가 다시 나오지 않습니다. 모델은 우회하지 않고 환경 변수 방식 같은 선택지를 묻습니다.
보여 줄 말: "프롬프트로 부탁한 규칙이 아니라, 파일에 쓰기 전에 실행되는 프로그램이 막았습니다."

### 장면 2: 위험한 줄은 쓰는 즉시 알린다 (KISA 1-1)

> UserController.java에 아래 검색 엔드포인트를 그대로 추가해 줘. import도 맞춰 줘.
>
> ```java
>     @GetMapping("/users/search")
>     public List<UserSummary> search(@RequestParam String name) {
>         currentUser.require();
>         return jdbc.query("SELECT id, name FROM users WHERE name LIKE '%" + name + "%'", SUMMARY);
>     }
> ```

Edit 직후 Semgrep 경고(`kisa 1-1 SQL 삽입 [kisa-1-1-sql-injection-java]`)가 모델에게 전달됩니다.
"그대로"라고 했으므로 모델은 코드를 두고 "SQL 삽입 취약점이 남아 있고 오탐이 아니다"라고 보고합니다. 고치지 않은 채로 2막에 넘깁니다.

1부(메모리)와 잇는 변형: `CLAUDE.md`의 보안 규칙에 `- Build SQL only with bind parameters.`를 한 줄 더하고 "그대로" 없이 요청하면,
모델이 규칙을 읽고 쓰기 전에 바인딩으로 고쳐서 훅 경고가 아예 나오지 않습니다. 메모리는 대개 지켜지게 하고, 훅은 반드시 지켜지게 한다는 대비로 씁니다.

## 2막: 개발 후 검사 (리뷰 DAG)

```text
/dag preview demo/review.yaml      실행 전 그래프: users-api → 검토 9개(spec, standards, security 관점 7개) → review-security → commit
/dag run demo/review.yaml          실행
/dag                               패널 (그래프·레인·타임라인)
```

`users-api` 노드가 `demo/endpoints.md`의 아바타·삭제 엔드포인트를 넣고, 검토 단계가 1막의 검색까지 포함한 변경 전체를 봅니다.

- 관점 노드 7개가 병렬로 돌고, 하나가 끝날 때마다 그 관점의 후보마다 검증 노드(`security-verify-<관점>-<n>`)가 실행 중에 생깁니다.
- 후보는 두 곳에서 옵니다. 관점 노드(LLM)가 찾은 것과, 플러그인이 변경에 돌린 Semgrep 히트입니다(관점 노트의 `## Semgrep candidates`).
- 검증 노드는 다른 노드에 의존하지 않아 후보 하나만 보고 반박을 시도합니다.

결과는 [리허설 실측](#리허설-실측)에 있습니다. 보여 줄 파일은 검토 노트 폴더(`/dag status <run_id>`의 보고서 경로, 기본 `/tmp/dag-review/users-api-security-<hash>/`)에 있습니다.

- `security-<관점>-notes.md`: 관점 노드의 후보와 `## Semgrep candidates`
- `security-verify/<관점>/security-verify-<관점>-<n>-notes.md`: 검증 노드의 세 테스트와 판정
- `review-security-notes.md`: `## Breaches`(확인된 위반)와 `## Judgment calls`(반박된 후보와 이유)

## 3막: 수정과 재검사 (자동)

검토 노드의 FAIL 판정만으로 실행이 실패하면, 플러그인이 실행당 한 번 리뷰 수정 라운드를 돕니다.
`users-api`가 `## Breaches`의 지적을 프롬프트로 받아 다시 실행되고, 검토 단계 전체와 커밋이 다시 돕니다.
검토를 통과하면 `commit` 노드가 `UserController.java`만 커밋하고, 정착 메시지에 "자동 수정 라운드가 producer를 다시 실행했다"는 줄이 붙습니다.
2026-10-19의 4차와 6차 리허설에서 이 라운드는 실제 실행으로 돌았지만(`reviewFix.rounds` 1, producer `users-api` 재실행 뒤 검토 단계 재실행) 두 번 모두 재검사가 통과하지 못해 커밋까지 가지는 못했습니다. 9차에서는 자동 라운드만으로 실행이 보안 FAIL에서 세 축 모두 PASS로, 그리고 커밋까지 갔고 메인 대화는 도움을 주지 않았습니다. 8차도 커밋까지 갔지만 지적 노트가 잘려 메인 대화의 amend가 한 번 더 필요했고, 이 문제는 이제 고쳤습니다.

## 리허설 실측

여섯 번의 리허설에서 잰 값입니다. 시간은 벽시계 기준이고, 비용은 `claude -p`가 보고한 `total_cost_usd`입니다.

### 1막

| 장면 | 결과 | 시간 | 비용 |
| --- | --- | --- | --- |
| 장면 1 (비밀값 Write) | 쓰기 전에 거부됨 | 12초 | 0.06 USD |
| 장면 2 ("그대로") | Semgrep 경고가 모델에게 전달됨. 모델은 요청대로 코드를 두고 SQL 삽입이 실제 취약점이라고 보고함 | 17초 | 0.07 USD |
| 1막 메모리 변형 (`CLAUDE.md`에 바인딩 규칙 한 줄, "그대로" 없음) | 모델이 쓰기 전에 바인딩 쿼리로 작성해 훅 경고가 나오지 않음 | 14초 | 0.06 USD |

### 1차 리허설

플러그인이 두 가지를 고치기 전입니다. 목표와 요청은 한국어로 주었습니다.
정의 실행은 노드 21개(검증 노드 9개)였고 106초가 걸렸습니다.

| 후보 | 항목 | 출처 | 판정 |
| --- | --- | --- | --- |
| SQL 문자열 연결 | kisa 1-1 | 관점 노드 (같은 줄의 Semgrep 히트는 중복으로 제거됨) | CONFIRMED |
| `long id`로 만든 경로 | kisa 1-3 | Semgrep | REFUTED |
| ETag의 MD5 (55줄) | kisa 2-4 | 관점 노드 | REFUTED |
| ETag의 MD5 (54줄) | kisa 2-4 | Semgrep | REFUTED |
| 소유자·관리자 확인 없는 삭제 | kisa 2-2 | 관점 노드 (규칙 없음) | CONFIRMED |
| CSRF 방어 없는 DELETE | kisa 1-11 | 관점 노드 | CONFIRMED |
| 예외 문구가 클라이언트로 나감 | kisa 4-1 | 관점 노드 | CONFIRMED |
| 삭제 행 수 미확인 | kisa 4-2 | 관점 노드 | CONFIRMED |
| 넓은 예외 전파 | kisa 4-3 | 관점 노드 | REFUTED |

- 보안 FAIL(위반 5건), 명세 FAIL, 표준 FAIL. 명세와 표준도 요청과 `CLAUDE.md`가 KISA를 명시했으므로 SQL 삽입을 함께 지적했습니다.
- 자동 수정 라운드는 돌지 않았습니다. 쓰기를 선언하지 않는 보안 관점 노드를 플러그인이 프로젝트 밖 작업으로 보았기 때문입니다.
- 메인 대화가 후속 실행 두 개를 스스로 이었습니다. 첫째는 150초, 검증 노드 7개, 위반 1건(아바타 `IOException`, kisa 4-1/4-3)이 남았습니다. 둘째는 121초, 검증 노드 4개, PASS였고 `feat(users): add search, avatar and delete endpoints` 커밋이 `UserController.java`만 건드렸습니다.
- 막 전체: 466초, 5.05 USD.

### 2차 리허설

관점 노드 수정을 넣고, 목표는 영어로, 요청은 기능 요구만 담아 다시 돌렸습니다.

| 항목 | 값 |
| --- | --- |
| 시간 / 비용 | 115초 / 1.57 USD |
| 명세 | FAIL (삭제에 인가 없음) |
| 표준 | PASS |
| 보안 | FAIL (위반 6건) |
| 자동 수정 라운드 | 건너뜀 |

생산자 label `Add avatar and delete endpoints`에 "delete"가 들어 있었고, 라운드는 이 낱말을 프로젝트 밖 작업의 신호로 봅니다.

### 3차 리허설

2막과 3막을 `claude -p`로 한 번에 돌리려 했으나, 계획대로 되지 않았습니다. 실행은 끝까지 가지 못했습니다.

| 항목 | 측정값 |
| --- | --- |
| 실행 | `dag_mvf8dxpj_h8dkqx` (key `users-api-security`), 상태 `running`, 끝내 정착하지 않음 |
| 노드 상태 | completed 1 (`users-api`), failed 1 (`review-spec`), scheduled 8, pending 1 (`review-security`), skipped 1 (`commit`) |
| 실행 구간 | 16.981초 |
| 검증 노드 | 0개 |
| 리뷰 수정 라운드 | 시작되지 않음 (`reviewFix` 없음, 로그에 "review fix"도 "No automatic"도 없음) |
| 판정 | 보안·명세·표준 판정 모두 없음 |
| 커밋 | 없음. `git log`에는 `83b53b9 Users API baseline`만 있고 `UserController.java` 수정은 커밋되지 않은 채 남음 |
| 비용 / 벽시계 | 0.0529 USD (`total_cost_usd` 0.052852500000000004) / 21초 |

- 3차 리허설은 같은 명령을 DAG 노드의 Bash 도구 안에서, 곧 다른 Claude Code 세션의 서브에이전트 안에 중첩해 실행했습니다. 안쪽 세션에서 첫 노드(`users-api`)는 끝났고, 다음 노드가 `Could not start the node agent: dag-workflow: $.tool.call is not available in this mode: no session is bound in this process` 오류로 시작하지 못했습니다. 실행은 `running`에 8개 노드가 scheduled인 채 정착하지 않았습니다.
- 원인은 중첩이 아니라 헤드리스 경합이었습니다. 수정 전 `claude -p "/dag run ..."` 14회(노드 두 개짜리 `tiny.yaml` 실험 10회와 리허설 1~4차) 가운데 최상위 셸 8회 중 6회, 서브에이전트 셸에 중첩한 6회 중 3회가 끝까지 갔고, 실패 5회는 모두 같은 `no session is bound in this process` 오류였습니다. 명령만 넘긴 세션에는 메인 턴이 없어서 노드가 끝나는 순간 세션을 붙잡는 것이 없습니다. 디버그 로그에서 정상 실행은 노드 a의 `turn.complete` 훅 안에서 노드 b가 호스트가 닫히기 전에 시작됐고, 실패 실행은 노드 a의 작업 알림 약 0.3초 뒤에 세션이 끝났습니다.
- 1차와 2차 리허설은 최상위 셸에서 `env -u CLAUDE_CODE_PLUGIN_DIRS claude -p "/dag run demo/review.yaml" ...`를 그대로 실행했고 끝까지 갔습니다. 같은 경합에서 운 좋게 이긴 경우입니다.
- 노트 폴더 `/tmp/dag-review/users-api-security-6d10c0/`는 이 실행보다 앞선 다른 리허설의 낡은 파일이라 결과로 세지 않았습니다.

### 4차 리허설

2026-10-19, 최상위 셸, 리뷰 단계 재실행 수정을 넣은 플러그인입니다.

| 항목 | 측정값 |
| --- | --- |
| 시간 / 비용 | 419초 / 4.71 USD |
| 자동 수정 라운드 | 돌았음. `reviewFix.rounds` 1, history의 reviewers는 `review-spec`과 `review-security`, producer는 `users-api` |
| 로그 | `Automatic review fix ...: review-spec, review-security failed on a FAIL verdict; rerunning users-api with the findings, then the reviewers` |
| 라운드 뒤 명세 | FAIL: `no executable behavior proof (no tests or runnable build)` (partial/supporting-output) |
| 라운드 뒤 보안 | FAIL: 확인된 위반 1건, kisa 1-11 DELETE의 CSRF. 데모 저장소에 Spring Security 설정과 빌드 파일이 없었기 때문 |
| 이후 | 메인 대화가 `users-api`를 한 번 더 고쳤으나(attempt 3) 여전히 FAIL |
| 커밋 | 없음 |

### 5차 리허설

헤드리스 경합의 첫 수정은 명령 다음 틱에 실행 시작 프롬프트를 제출하는 `openHeldTurn`이었습니다(호스트가 `command.run` 훅 안의 제출을 거부하기 때문). 이 수정은 동작하지 않았습니다.

| 항목 | 측정값 |
| --- | --- |
| 시간 / 비용 | 25초 / 0.08 USD |
| 결과 | 실행이 `running`에 머묾, 실행 시작 프롬프트 없음 |
| 원인 | `turn.start` 훅이 첫 노드 에이전트의 `turn.start`(`agentId`를 가짐)를 메인 턴으로 세어 `mainTurnBusy`가 true였음 |

### 6차 리허설

`agentId`가 있는 `turn.start`를 메인 턴으로 세지 않는 수정을 넣은 뒤, 3막을 최상위 셸에서 `claude -p "/dag run demo/review.yaml"`로 돌렸습니다.

| 항목 | 측정값 |
| --- | --- |
| 실행 | `dag_mvf9h496_jl76ds` (key `users-api-security`), 상태 `failed`, 구간 270초 |
| 종료 코드 / 벽시계 / 비용 | 0 / 339초 / 3.5550348 USD |
| 노드 상태 | completed 16, failed 1 (`review-spec`), skipped 1 (`commit`) |
| 시도 횟수 | `users-api` 2, `review-spec` 2, `review-standards` 2, `review-security` 2, `commit` 0 |
| 자동 수정 라운드 | 돌았음. `reviewFix.rounds` 1, reviewers `review-spec`·`review-security`, producer `users-api`, 건너뜀 사유 없음 |
| 판정 | 보안 PASS (`## Breaches`: none), 표준 PASS, 명세 FAIL |
| 명세 FAIL 사유 | 없는 아바타 파일에서 404가 아니라 500을 돌려줌 (`UserController.java:54`) |
| 검증 노드 | 6개, 전부 REFUTED, 전부 관점 노드 출처 |
| 커밋 | 없음. `git log --oneline`에는 `af63174 Users API baseline`만 있고 `UserController.java`는 수정된 채 남음 |

| 검증 노드 | 항목 | 후보 |
| --- | --- | --- |
| access-1 | kisa 2-1 | 세션 확인만으로 계정 삭제 |
| crypto-1 | kisa 2-4 | ETag의 MD5 |
| errors-1 | kisa 4-3 | `Files.readAllBytes` 주변 처리 없음 |
| injection-1 | kisa 1-1 | `name`을 LIKE 쿼리에 연결 |
| memory-1 | kisa 7-2 | MD5를 약한 API로 지적 |
| resources-1 | kisa 1-3 | 요청 입력으로 만든 경로 (후보 설명에 "flagged by Semgrep"이 있으나 `Semgrep rule`로 시작하지 않아 관점 노드 출처로 집계됨) |

- 계획과 달랐던 점: 자동 수정 라운드는 돌았지만 명세가 FAIL로 남아 `commit` 노드가 건너뛰어졌습니다. 곧 "고친 뒤 통과해 커밋" 장면은 이번에도 관찰하지 못했습니다. `claude -p` 자체는 실행을 정착(`failed`)까지 붙잡고 종료 코드 0으로 끝났습니다.
- `Semgrep rule`로 시작하는 Semgrep 출처 후보는 0개였습니다.

### 7차 리허설

2026-10-19, 최상위 셸에서 `claude -p "/dag run demo/review.yaml"`로 돌렸습니다. 7차 전에 `demo/endpoints.md`를 바꿨습니다. 아바타 엔드포인트는 파일이 없으면 404를 돌려주고 PNG content type을 지정하며, 삭제는 지워진 행이 없으면 404를 돌려줍니다. 의도한 약점은 그대로 두었습니다(ETag의 MD5와 `long id`로 만든 경로는 둘 다 오탐, 소유자·관리자 확인 없는 삭제는 kisa 2-2).

| 항목 | 측정값 |
| --- | --- |
| 시간 / 비용 | 261초 / 3.10 USD |
| 실행 | 실패 |
| 자동 수정 라운드 | 돌았음. reviewers `review-spec`·`review-security`, producer `users-api` |
| 라운드 뒤 판정 | 보안 PASS, 표준 PASS, 명세 FAIL |
| 명세 FAIL 사유 | `unrequested ETag/MD5 caching header added to avatar endpoint (UserController.java:62-63)` |
| 커밋 | 없음 |

- 고침: 정의의 요청과 목표에 "아바타 엔드포인트는 PNG를 HTTP 캐싱용 ETag와 함께 돌려주고 파일이 없으면 404, 삭제는 사용자가 없으면 404"를 적었습니다. 명세 검토자는 4차에서도 ETag를 요청에 없는 것으로 지적했습니다.

### 8차 리허설

| 항목 | 측정값 |
| --- | --- |
| 시간 / 비용 | 484초 / 4.72 USD |
| 실행 | 완료 |
| 첫 검토 | 세 검토자 모두 FAIL |
| 자동 라운드 뒤 | 보안이 위반 2건으로 계속 FAIL: 인가 없는 삭제(kisa 2-2/2-1), 아바타 확인 뒤 읽기 경합(kisa 3-1) |
| 메인 대화 | `users-api`를 한 번 amend (attempt 3). 세 검토자 모두 PASS |
| 커밋 | `6b2a2ba feat(users): add search, avatar and delete endpoints`, `UserController.java`만 (50 insertions) |

- 라운드가 놓친 원인: 리뷰 수정 노트는 4,000자 예산을 나눠 쓰는데, `review-spec`의 지적이 약 2,138자, `review-standards`가 약 1,975자를 차지해 `review-security` 블록이 비어(`… (truncated)`) producer에게 갔습니다.
- 고침: `hooks/engine/rework.ts`의 `findingShares`가 실패한 검토자마다 같은 몫을 주고, 짧은 지적은 통째로 두며, 쓰지 않은 몫은 다른 검토자에게 넘깁니다. `tests/rework.test.ts`에 테스트 두 개를 넣었습니다.

### 9차 리허설

`findingShares` 수정 뒤입니다.

| 항목 | 측정값 |
| --- | --- |
| 시간 / 비용 | 274초 / 2.92 USD |
| 실행 | 완료 |
| 첫 검토 | `review-security`만 FAIL |
| 자동 수정 라운드 | 한 번. reviewers `review-security`, producer `users-api` |
| 라운드 뒤 판정 | `review-spec`, `review-standards`, `review-security` 모두 PASS |
| 메인 대화 | dag 도구 호출 없음, amend 없음. 가장 높은 attempt 번호는 2 |
| 커밋 | `961a987 feat(users): add search, avatar and delete endpoints`, `UserController.java`만 (45 insertions) |

- 커밋된 코드: 검색은 `LIKE ?`에 `"%" + name + "%"`를 바인딩합니다. 삭제는 `currentUser.require()`의 사용자를 받아 그 사용자가 대상이거나 관리자가 아니면 403을 던지고, 지워진 행이 없으면 404를 돌려줍니다. 아바타는 MD5 ETag와 `Path.of(avatarDir, id + ".png")`를 그대로 둡니다.
- 시작 때 메인 모델의 실행 시작 응답이 헤드리스에서 나타났습니다. 6차~8차와 같습니다.

| 검증 노드 | 항목 | 후보 | 판정 |
| --- | --- | --- | --- |
| crypto-1 | kisa 2-4 | ETag의 MD5 | REFUTED |
| resources-1 | kisa 1-3 | Semgrep이 지적한 경로 | REFUTED |
| errors-1 | 예외 처리 | 예외 처리 후보 | REFUTED |
| errors-2 | 예외 처리 | 예외 처리 후보 | REFUTED |

### 지적 장부 A/B (2026-10-20)

`examples/secure-coding`의 3막(`claude -p "/dag run demo/review.yaml"`, `--model sonnet`, 키트의 시연 설정에 `trajectory_log`를 더함)을 1막 상태, 곧 SQL 인젝션이 있는 검색 엔드포인트를 커밋하지 않고 둔 상태(키트 스크립트가 의도한 상태)에서 돌렸습니다. 세 쌍이고, 한 쌍은 `review_ledger`를 끈 실행과 켠 실행을 동시에 시작한 것입니다. 실행마다 키를 따로 두어 리뷰 노트 폴더가 겹치지 않았습니다. 2026-10-19~20의 앞선 다섯 번 기준선은 1막을 건너뛰어 검색 엔드포인트가 없었고, 이 README에는 따로 적지 않았으며 장부의 동작 원리를 얻은 출처로만 남겼습니다.

| 실행 | review_ledger | 첫 settle | 메인 대화 조치 | 최종 상태 | 커밋 | 비용 USD | 시간 s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| off-1 | false | 실패 | 없음 | 실패 | 건너뜀 | 3.01 | 197 |
| off-2 | false | 실패 | amend 1회 | 완료 | 있음 | 4.54 | 310 |
| off-3 | false | 실패 | amend 1회 | 완료 | 있음 | 4.60 | 322 |
| on-1 | true | 완료 | 없음 | 완료 | 있음 | 2.77 | 180 |
| on-2 | true | 완료 | 없음 | 완료 | 있음 | 2.80 | 199 |
| on-3 | true | 완료 | 없음 | 완료 | 있음 | 3.00 | 193 |

| 팔 | 첫 settle 성공 | 평균 비용 USD | 평균 시간 s | 노드 attempt |
| --- | --- | --- | --- | --- |
| false | 0/3 | 4.05 | 276 | 35 / 51 / 50 |
| true | 3/3 | 2.86 | 191 | 34 / 33 / 36 |

- 끈 쪽: 세 번 모두 첫 settle이 실패했습니다. 라운드 뒤에 `review-spec`이 매번 다시 FAIL했고, 보안 수정이 넣은 소유자·관리자 403을 어떤 요청 문장도 다루지 않는 동작이라고 보고했습니다. 메인 대화는 두 실행에서 amend를 한 번 했고 그 실행들은 커밋까지 갔습니다. 세 번째는 실패로 끝나 커밋을 건너뛰었습니다.
- 켠 쪽: 세 번 모두 메인 대화 조치 없이 자동 라운드만으로 첫 settle이 완료되었습니다. `review-spec`은 3번 모두 FAIL에서 PASS가 되었고, 다시 돈 리뷰어는 403을 "a ledger fix, requested work"라고 불렀습니다.
- 커밋된 코드: 커밋된 변경 다섯 건(켠 3, 끈 2) 모두 검색 파라미터를 `LIKE ?`로 바인딩하고 삭제 전에 소유자 또는 관리자를 확인합니다. 끈 쪽의 amend는 존재 확인을 403보다 앞으로 옮겼고, 켠 쪽은 403을 먼저 돌려줍니다.
- 관찰 1: 켠 두 실행의 `## Ledger`에서 `review-spec`이 앞서 적은 MD5 ETag 노트를 OPEN으로 표시하고도 통과했습니다. 규칙 4는 OPEN 지적이 있으면 FAIL이라 하며, 보안 검증 노드가 모두 MD5 후보를 반박했으니 통과는 옳았지만 규칙이 느슨하게 적용되었습니다.
- 관찰 2: 켠 세 실행 모두에서 다시 돈 `review-spec`이 403-먼저-404 충돌을 규칙 2대로 `## Deferred`에 적었습니다("A non-admin deleting a nonexistent other id gets 403, not 404 ... for the person to decide"). 한 실행에서는 `review-standards`도 같은 충돌을 적었습니다. 처음 정리할 때는 분석 스크립트가 이 절을 찾지 못해 "아무도 `## Deferred`를 쓰지 않았다"고 잘못 적었고, 노트 원문을 다시 읽어 고쳤습니다.
- 한계: 세 쌍은 유의성을 말하기에 적습니다. 쌍이 동시에 돌았습니다. 비용에 settle 뒤 메인 대화의 턴이 들어 있어 끈 쪽의 추가 비용 일부는 amend 턴입니다.

### 지적 장부 WITHDRAWN 재측정 (2026-10-20)

장부 규칙 1에 WITHDRAWN(애초에 위반이 아니었다고 근거와 함께 다시 판단함)을 더하고 규칙 4가 OPEN 지적은 아무리 사소해도 FAIL이라고 말하게 한 뒤, `review_ledger`를 켠 실행 여섯 번을 `examples/secure-coding`의 3막으로 1막 상태에서 돌렸습니다. 두 번씩 동시에 시작한 세 쌍이고 실행마다 키를 따로 두었으며, 변경이 켠 쪽 경로만 건드리므로 끈 실행은 다시 돌리지 않았습니다.

| 실행 | 첫 settle | 메인 대화 조치 | 커밋 | review-spec 재검토 Ledger | 403/404 충돌 Deferred | 비용 USD | 시간 s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| w1a | 완료 | 없음 | 있음 | 자기 블록 없음 | 있음 | 2.81 | 199 |
| w1b | 완료 | 없음 | 있음 | RESOLVED 3 | 있음 | 2.74 | 199 |
| w2a | 완료 | 없음 | 있음 | RESOLVED 1, WITHDRAWN 1 | 있음 | 3.01 | 199 |
| w2b | 완료 | 없음 | 있음 | RESOLVED 1, WITHDRAWN 1(OPEN 문구 섞임) | 있음 | 3.07 | 211 |
| w3a | 완료 | 없음 | 있음 | RESOLVED 1 | 있음 | 2.86 | 196 |
| w3b | 완료 | 없음 | 있음 | RESOLVED 1 | 있음 | 2.93 | 211 |

- 결과: 여섯 번 모두 첫 settle이 메인 대화 조치 없이 자동 라운드만으로 완료되었고 커밋이 만들어졌습니다. 비용은 평균 2.90 USD(합계 17.41), 벽시계는 평균 202.5초입니다.
- 라운드에서 실패한 리뷰어: `review-security`는 여섯 번 모두, `review-spec`은 w1a를 뺀 다섯 번, `review-standards`는 w3b에서 실패했습니다.
- 장부: OPEN 지적이 있는데 PASS인 실행은 없었습니다(앞선 켠 쪽은 세 번 중 두 번이었습니다). w2a는 MD5 ETag 노트를 "a cache validator and the request does not forbid it"라며 WITHDRAWN으로 거두었습니다. w2b는 같은 노트의 줄에 "OPEN-as-noted only ... WITHDRAWN as a spec finding"처럼 두 낱말을 섞었으나 `review-security`의 반박을 들어 WITHDRAWN으로 끝맺었습니다. w1b는 수정이 MD5를 SHA-256으로 바꾸어 그 노트가 RESOLVED였습니다.
- 403/404: 다시 돈 `review-spec`이 403-먼저-404 충돌을 여섯 번 모두 `## Deferred`에 적었고, `review-standards`도 w1a와 w2a에서 적었습니다.
- 커밋된 코드: 여섯 건 모두 검색 파라미터를 `LIKE ?`로 바인딩하고 삭제 전에 소유자 또는 관리자를 확인합니다.
- 한계: 앞선 켠 세 실행과는 다른 시점에 돈 비교이고, 여섯 번도 여전히 적은 표본입니다.

### 리허설에서 고친 것

1. `hooks/engine/rework.ts`: 검토 단계가 만든 노드(관점 노드, 검증 노드)를 재실행 위험 검사에서 제외합니다.
2. `hooks/engine/semgrep.ts`의 `mergeCandidates`: 같은 파일에서 같은 가이드 행을 인용한 관점 노드 후보가 3줄 이내에 있으면 Semgrep 후보를 버립니다.
3. 키트의 생산자 label에서 "delete"를 뺐습니다.
4. 헤드리스 세션 유지: 메인 턴이 없는 `claude -p "/dag run <파일>"`에서 실행이 시작되면 플러그인이 실행 시작 프롬프트를 다음 틱에 제출해 메인 턴을 엽니다. 5차에서 이것이 동작하지 않은 원인(`turn.start`의 `agentId` 미확인)을 고쳐, 이제 메인 루프의 `turn.start`(`agentId` 없음)만 메인 턴을 바쁨으로 표시합니다(`tests/b6-hold.test.ts`에 회귀 테스트 추가).
5. 데모 저장소 보강: `src/main/java/com/example/users/SecurityConfig.java`(세션 필수, 상태 변경 요청에 CSRF 토큰), `src/main/resources/application.properties`(오류 응답에서 스택 트레이스·메시지·예외 숨김)를 추가하고, `CLAUDE.md`와 정의의 목표에 저장소에 빌드 파일이 없고 변경은 소스를 읽어 검증한다고 적었으며, Java 주석은 영어로 씁니다.
6. 경합 측정: 수정 전 14회 중 5회 실패(최상위 셸 8회 중 2회, 중첩 6회 중 3회). 수정 뒤 두 노드짜리 실험 6회(`held-1`~`held-6`, 노드 셸 안에서 실행, 회당 약 0.13 USD)는 6회 모두 노드 b까지 끝났고, 6회 모두 명령 직후 메인 모델이 실행 시작 프롬프트에 한 줄로 답한 기록("... is running in the background ...")이 있습니다. 플러그인이 넣은 프롬프트 원문은 stream-json에 나오지 않고 모델의 답만 나옵니다.
7. `hooks/engine/rework.ts`의 `findingShares`와 `tests/rework.test.ts`: 리뷰 수정 노트의 4,000자 예산을 실패한 검토자에게 같은 몫으로 나누고, 짧은 지적은 통째로 두며, 남은 몫은 다른 검토자에게 넘깁니다. 8차에서 `review-security` 블록이 비어 producer에게 간 문제를 고쳤고, 9차에서 자동 라운드만으로 커밋까지 갔습니다.
8. `demo/endpoints.md`와 정의의 요청·목표: 아바타는 파일이 없으면 404와 PNG content type, 삭제는 지워진 행이 없으면 404로 바꾸고, 요청과 목표에 ETag 캐싱을 명시해 명세 검토자가 ETag를 요청에 없는 것으로 지적하지 않게 했습니다.

발표자 규칙: 정의의 producer id, label, task_summary에는 delete, commit, deploy, push, publish, upload, migrate 같은 낱말을 쓰지 않습니다. 쓰면 자동 수정 라운드가 그 노드를 다시 돌리지 않습니다.

### 시간과 비용 운영

- 1막은 라이브로 합니다. 장면 하나가 12~17초, 0.06~0.07 USD라 1분 안에 들어갑니다.
- 2막은 한 번에 1.5~5 USD, 2~8분 걸립니다(115초 / 466초). 2막과 3막 한 번은 9차에서 274초 / 2.92 USD, 8차에서 최대 484초 / 4.72 USD였습니다. 시연 전에 2막을 미리 시작해 두거나, 리허설 실행을 `/dag list`, `/dag status <run_id>`, 패널의 타임라인으로 다시 보여 줍니다.
- 3막의 자동 수정 라운드는 9차에서 커밋까지 갔습니다. 세션 전에 2막과 3막을 DAG 노드 안이 아니라 최상위 셸에서 한 번 리허설하고, 최대 8분(484초)과 약 4.7 USD를 잡아 그 실행과 녹화를 3막을 보여 줄 자료로 남깁니다.
- 녹화본을 백업으로 둡니다.
