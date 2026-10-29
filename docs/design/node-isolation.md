# 노드 격리 설계: 노드마다 git worktree (O2)

작성 2026-10-28. 근거: `docs/external-benchmark-plan.md`의 O2와 X4, 호스트 타입 선언 `.claude-plugin/types/claude-code/index.d.ts`(아래 `index.d.ts:<줄>`), 이 저장소의 코드(브랜치 `fix/host-2-1-311-permission-gate`, `48555d7`).
조사 문서다. 코드는 바꾸지 않았고 `git worktree`도 실행하지 않았다. Orca의 `worker-start --worktree`(태스크마다 worktree)와 `worktree ps`(worktree 요약)를 참고했다.

## 문제

지금은 모든 노드가 한 작업 트리, 곧 세션의 프로젝트 루트를 같이 쓴다.

- `startNode`(`hooks/register.ts:1452`)는 `$.agent.spawn`에 `prompt`, `description`, `subagentType`, `model`만 넘긴다(`hooks/register.ts:1473-1478`). `cwd`를 넘기지 않으므로 노드는 부모와 같은 디렉터리에서 돈다(`index.d.ts:403-404`).
- 검증도 같은 트리에서 한다. 명령 검사는 `cwd: projectRoot`로 실행되고(`hooks/register.ts:2151`), 파일 검사의 상대 경로는 `resolveCheckPath`가 프로젝트 루트에 붙인다(`hooks/register.ts:2054-2057`). 같은 argv의 명령 검사는 `oneAtATime`이 argv를 키로 한 번에 하나씩 돌린다(`hooks/register.ts:2151`).
- 동시에 도는 레인이 서로의 파일을 건드리지 않게 하는 장치는 계획 단계에만 있다. 미리보기의 `writeConflicts`(`hooks/engine/preview.ts:72`)는 동시에 돌 수 있는 두 노드의 `writes` 겹침을 보여 줄 뿐 막지 않는다. lint는 한 생산자가 파일을 너무 많이 가지면 나누라고 경고한다(`hooks/engine/lint.ts:195`). 계획 교리는 "Disjoint write scopes or serialize"(`skills/planning/references/planning.md:259`)와 전체 스위트 검사를 웨이브 뒤로 미루라는 규칙(`planning.md:261`)을 두고, 노드별 worktree 격리가 없다는 한계를 밝힌다(`planning.md:187`).
- 2026-10-28 사례: 한 웨이브의 세 레인이 각각 `claude plugin test .`로 검증했고, 그중 둘이 다른 레인이 아직 고치던 테스트에 걸려 실패했다(`planning.md:261`). `writes`는 겹치지 않았다. 전체 스위트 검사가 다른 레인의 반쯤 된 편집까지 판정했고, 같은 argv라서 세 레인이 스위트 시간만큼 줄을 섰다.

노드마다 자기 worktree에서 편집하고 검증하면 레인의 검사는 자기 변경과 시작 시점의 트리만 본다. 그러나 격리가 없애지 못하는 것도 있다.

- 같은 파일을 고친 두 레인의 충돌은 사라지지 않고 병합 시점으로 옮겨 간다.
- 공유 타입을 넓힌 레인 때문에 다른 레인의 소비자가 깨지는 문제(`planning.md:260`)는 병합한 뒤에야 드러난다. 웨이브 뒤 통합 검사 노드는 격리해도 필요하다.

## 선택지

### (a) 호스트 격리: `isolation: 'worktree'` 에이전트 정의

플러그인이 `$.agent.register`(`index.d.ts:3314`)로 `isolation: 'worktree'`(`index.d.ts:555`)를 가진 타입, 예를 들어 `dag-workflow:node-worker`를 등록한다. `startNode`는 그 타입을 `subagentType`으로 지정하고, worktree를 만들고 지우는 일은 호스트가 맡는다.

선언에서 확인한 걸림돌:

1. `isolation`은 정의의 필드이고 spawn 인자가 아니다. `AgentSpawnArgs`는 `prompt`, `description`, `subagentType`, `model`, `name`, `cwd`만 받는다(`index.d.ts:251`). 노드는 정의의 `agent`로 타입을 고른다(`hooks/engine/node-prompt.ts:30-33`, 예: `code-reviewer`). 격리를 지키려면 노드가 고를 수 있는 타입마다 worktree판 쌍둥이를 등록해야 한다. 그런데 `AgentSpec.prompt`는 시스템 프롬프트 전체를 대체하고(`index.d.ts:479`), `$.agent`에는 `spawn`, `list`, `register`만 있어(`index.d.ts:3279`, `3288`, `3314`) 다른 타입의 프롬프트와 도구를 읽어 복제할 방법이 없다. 결국 노드의 `agent` 선택을 잃는다.
2. 플러그인이 호스트가 만든 worktree의 경로나 브랜치를 받을 곳이 선언에 없다. spawn 결과는 `model`, `agentId`, `teammateId`뿐이고(`index.d.ts:422`), `turn.complete` 필드는 `answer`, `durationMs`, `isAborted`, `turnId`, `agentId`, `usage`뿐이다(`index.d.ts:14279`). `$.agent.list()`의 `AgentInfo`에도 디렉터리 필드가 없다(`index.d.ts:125`). 경로를 모르면 병합도, 검증 위치 변경도, 정리도 할 수 없다. 남는 방법은 에이전트가 답에 경로를 쓰게 하는 것뿐이고, 이는 기계적 계약이 아니다.
3. 우회로로 `classic.WorktreeCreate` 훅이 있다. classic 이벤트는 settings 훅이 없어도 발생하므로(`index.d.ts:1270-1274`) 플러그인이 받을 수 있다. 결과의 `worktreePath`로 worktree 위치도 정할 수 있다(`index.d.ts:1381-1387`, `1412`). 하지만 입력은 기본 필드와 `name`뿐이고(`index.d.ts:15748-15751`), 그 `name`이 어느 spawn에서 왔는지는 선언에 없다. `agent_id`는 서브에이전트 안에서 발생한 훅에만 붙는데(`index.d.ts:863`), 격리 worktree를 만드는 훅이 서브에이전트 안에서 발생하는지도 선언에 없다. 위치를 플러그인이 정하는 순간 (b)와 같은 일을 더 간접적으로 하게 된다.
4. 언제 지우는지가 선언에 없다. 플러그인의 spawn은 모두 백그라운드로 돈다(`index.d.ts:248-249`, `3269-3270`). 2.1.311에서 고친 "백그라운드 서브에이전트가 쓰는 worktree 삭제" 버그(`docs/external-benchmark-plan.md:104`)가 바로 이 경로에 있다. 이 플러그인의 최소 버전은 2.1.287이므로(`README.md:26`), 2.1.311 미만에서는 노드가 일하는 도중에 worktree가 사라질 수 있다. (a)를 택하면 최소 버전을 2.1.311로 올려야 한다.
5. 검증(`hooks/register.ts:2151`, `2054-2057`), 리뷰(`hooks/engine/stages.ts:164`), 커밋(`hooks/engine/stages.ts:539`)은 모두 메인 트리를 본다. 노드의 변경이 메인 트리에 없으므로 검사와 리뷰가 빈 변경을 판정한다.

### (b) 플러그인 관리: `git worktree add` 후 `$.agent.spawn({ cwd })`

`startNode`가 spawn 전에 `$.process.run(['git', 'worktree', 'add', '--detach', <경로>, <기준 커밋>], { cwd: projectRoot })`를 실행한다(`index.d.ts:3616`, `8238-8242`). 이어서 `$.agent.spawn({ ..., cwd: <경로> })`로 노드를 그 디렉터리에서 띄운다(`index.d.ts:251`, `403-408`). 경로와 기준 커밋은 체크포인트에 기록한다.

노드가 끝나면 다음 순서로 처리한다.

1. 노드 worktree에서 검증한다(`ProcessRunInit.cwd`, 파일 검사도 worktree 기준).
2. 통과하면 worktree의 변경을 기준 커밋과 비교한 diff로 만든다. 노드의 `writes` 안의 변경만 메인 트리에 `git apply`로 적용한다. 인덱스는 건드리지 않으므로 메인 트리에는 미커밋 변경으로 남는다.
3. 적용에 성공하면 `git worktree remove`로 지우고 노드를 `completed`로 둔다.

추가 설계 요소:

- **기준 커밋:** worktree에는 추적 파일의 커밋 상태만 들어간다. 실행 시작 때 메인 트리에 있던 미커밋 변경과 앞서 병합된 생산자의 변경을 노드가 보려면, 플러그인이 그 상태를 스냅숏 커밋으로 만들어 기준으로 삼아야 한다. 예를 들어 임시 인덱스로 `git add -A`와 `git write-tree`, `git commit-tree`를 실행하면 메인 트리를 바꾸지 않는다.
- **무시된 파일:** 무시된 파일은 worktree에 없다. 이 저장소의 `.claude-plugin/types/`가 무시 대상이다(`.gitignore:1`). 그래서 worktree 안에서는 `tsc`와 `claude plugin test`가 생성된 타입 없이 돈다. `node_modules`도 마찬가지다. 복사하거나 심볼릭 링크로 걸 목록을 설정으로 받아야 한다.
- **git 훅:** `$.process.run`의 git은 저장소 훅을 끄고 돈다(`index.d.ts:3606`). `post-checkout` 훅으로 의존성을 설치하는 저장소라도 worktree 생성 때 그 훅은 실행되지 않는다.
- **다른 플러그인:** 다른 플러그인의 `agent.spawn` 훅도 `cwd`를 다시 쓸 수 있다(`index.d.ts:257-259`). 이 플러그인의 훅(`hooks/register.ts:4078`)은 `cwd`를 건드리지 않고 넘긴다.

### (c) 공유 트리 유지 (기준선)

지금 방식을 유지하고 2026-10-28에 보강한 교리를 따른다. 레인은 자기 파일만 검사하고, 전체 스위트는 모든 레인에 `dependsOn`한 노드 하나에서 한 번 돌린다(`planning.md:261`). 겹치는 `writes`는 `dependsOn`으로 직렬화하거나 노드를 합친다(`planning.md:259`). 혼자서 초록이 될 수 없는 migrate 배치는 병렬로 돌리지 않는다(`planning.md:187`).

## 비교

| 기준 | (a) 호스트 `isolation: 'worktree'` | (b) 플러그인 `git worktree add` + `cwd` | (c) 공유 트리 |
| --- | --- | --- | --- |
| 메인 트리로 병합하는 순서 | 정할 수 없다. 플러그인이 worktree 경로와 브랜치를 받지 못한다(`index.d.ts:422`, `14279`). | 검증을 통과한 순서대로 하나씩 적용한다(직렬 큐). 의존 노드는 생산자가 모두 병합된 뒤 시작한다. | 병합이 없다. 노드가 쓰는 즉시 메인 트리에 반영된다. |
| 충돌이 났을 때 | 사람이 호스트가 남긴 worktree를 찾아 직접 합친다. 플러그인은 충돌이 난 줄도 모른다. | `git apply` 실패를 새 실패 종류(병합 충돌)로 기록하고 노드를 `failed`로 둔다. worktree는 보존해 경로를 보여 주고, 재시도는 새 기준 커밋에서 한다. `writes` 밖의 변경도 병합에서 거부해 보여 준다. | 충돌 대신 섞인다. 동시 레인이 같은 파일을 쓰면 나중 쓰기가 남고 아무도 알리지 않는다. 막는 장치는 미리보기 경고와 교리뿐이다. |
| review-spec·review-standards가 읽는 diff | 리뷰는 메인 트리의 `git diff`를 읽는다(`stages.ts:164`). 노드 변경이 거기 없으므로 빈 변경을 리뷰한다. | 리뷰 노드는 읽기 전용이라 격리하지 않는다. 모든 생산자가 병합된 뒤 메인 트리에서 돌기 때문에 지금과 같은 diff를 읽고, 프롬프트도 그대로 둔다. | 지금과 같다. 실행 전부터 있던 변경은 프롬프트가 따로 구분하게 한다(`stages.ts:167`). |
| 검증 명령이 도는 곳 | 메인 트리(`register.ts:2151`)다. 노드 변경이 없으므로 검사가 실패하거나 엉뚱한 것을 통과시킨다. 경로를 모르니 옮길 수도 없다. | 노드 worktree(`index.d.ts:8238-8242`)다. 다른 레인의 미완성 편집을 보지 않는다. 다만 큐 키에 `cwd`를 넣어야 worktree 사이에 병렬로 돈다. 병합 뒤 메인 트리에서 다시 돌릴지는 결정할 일이다. | 메인 트리다. 다른 레인의 편집이 보이므로 교리로 피한다(`planning.md:261`). |
| 의존 노드가 생산자의 파일을 보는 방법 | 생산자의 변경이 다른 worktree에 갇혀 있다. 의존 노드가 새로 받는 worktree에는 그 변경이 없다. | 생산자 병합 뒤 메인 트리 스냅숏에서 의존 노드의 worktree를 만든다. 파일은 보이지만 병합하는 시간만큼 시작이 늦어진다. upstream `## Output`(`register.ts:1462-1466`)은 지금처럼 전달된다. | 즉시 보인다. upstream `## Output`도 함께 전달된다. |
| 정리 시점과 크래시 복구 | 호스트가 정하지만 시점이 선언에 없다. 2.1.311 미만에서는 일하는 도중 삭제될 위험이 있다. 세션이 죽으면 남은 worktree를 플러그인이 모른다. | 병합에 성공하면 바로 지운다. 충돌하거나 실패하면 보존하고, 실행 정산이나 보존 정책(`retentionPlan`)이 지운다. 세션을 재개하면 체크포인트의 경로와 `git worktree list --porcelain`을 맞춰 고아 worktree를 정리한다. | 정리할 것이 없다. 크래시는 반쯤 쓴 파일을 메인 트리에 남긴다(지금과 같다). |
| 디스크와 시간 비용 | 노드마다 추적 파일 전체를 체크아웃한다. `max_concurrent` 기본값이 8이라(`.claude-plugin/plugin.json:192-196`) 동시에 최대 8벌이다. 무시된 의존성은 노드마다 다시 갖춰야 한다. | (a)와 같은 디스크 비용에, 노드마다 git 호출이 더해진다(add, 스냅숏, diff, apply, remove). git 호출은 기본 30초, 최대 10분 제한을 받는다(`index.d.ts:3610`). 병합 대기 시간도 생긴다. | 추가 비용이 없다. 대신 같은 스위트 검사를 쓰는 레인끼리 줄을 선다(`register.ts:2151`). |
| 사용자에게 바뀌는 것 | 노드가 고른 `agent` 타입이 무시되거나 플러그인 타입으로 바뀐다. 최소 버전이 2.1.311로 오른다. 결과물이 어디 있는지 알기 어렵다. | 새 설정(격리 켜기·끄기, 복사할 무시 파일 목록), 패널의 병합 상태, 새 실패 종류(병합 충돌)가 생긴다. 노드가 쓰는 중인 파일은 병합 전까지 메인 트리에 보이지 않는다. 교리 `planning.md:187`, `259`, `261`도 고쳐야 한다. | 바뀌는 것이 없다. |

## 권장안

**지금은 하지 않는다(not now). 지금은 (c)를 유지하고, 조건이 바뀌면 (b)를 구현한다. (a)는 조건과 무관하게 택하지 않는다.**

이유:

1. 2026-10-28 실패는 공유 트리 자체보다 레인마다 전체 스위트 검사를 둔 계획에서 나왔고, 같은 날 교리(`planning.md:261`)가 그 원인을 고쳤다.
2. (b)는 병합, 검증 위치, ledger 스냅숏, 정리, 크래시 복구를 모두 바꾼다. `hooks/register.ts`에서 `projectRoot`가 나오는 줄만 85줄이다. `docs/external-benchmark-plan.md`의 D-X4도 O1을 먼저 하라고 권한다.
3. (a)는 경로를 받을 API가 없어 병합할 수 없다. 노드의 `agent` 선택도 잃고, 2.1.311 미만에서는 삭제 버그를 그대로 맞는다. 호스트가 spawn 결과나 `turn.complete`로 worktree 경로와 브랜치를 주고 `isolation`을 spawn 인자로 받게 되면 그때 다시 검토한다.

**(b)로 바꿀 조건.** 아래 둘 중 하나가 생기면 바꾼다.

- 교리를 고친 뒤에도 같은 실패가 나온다. 곧 `writes`가 겹치지 않고 레인 검사를 자기 파일로 좁힌 실행에서, 레인이 동시에 돌던 다른 노드의 `writes` 안 파일 때문에 명령 검사에 실패한 사례가 2주 안에 2번 이상 나온다. 판정은 `.claude/dag/runs/<run>/<node>.verification.<n>.json`의 `failed` 명령 검사 `detail`이 동시 노드의 `writes` 안 경로를 가리키는지로 한다.
- 사용자가 혼자서는 초록이 될 수 없는 migrate 배치를 병렬로 돌려야 한다(`planning.md:187`).

**(b)를 구현할 때 바꿀 파일:**

- `hooks/engine/isolation.ts`(새 파일, 순수 로직): worktree 경로 이름, add·스냅숏·diff·apply·remove의 argv, 병합 큐 순서, 충돌 분류, `git worktree list --porcelain` 파싱과 고아 판정.
- `hooks/register.ts`:
  - `startNode`(1452): worktree 생성과 spawn의 `cwd`.
  - `commandCheckResult`(2150), `fileCheckResult`(2116), `resolveCheckPath`(2054): 노드 루트를 인자로 받는다. `oneAtATime` 키에 `cwd`를 넣는다.
  - 완료 처리: worktree에서 검증하고, 병합한 뒤에 `completed`로 둔다. 병합에 실패하면 `failed`로 둔다.
  - `endSnapshot`(2277-2281): worktree 기준으로 바꾼다.
  - review-fix ledger의 `recordBeforeFix`·`ledgerFiles`·fix diff(1908, 1920, 1972): 병합된 메인 트리 기준인지 다시 확인한다.
  - 세션 간 `writes` 표시(1257): 그대로 둔다.
  - 재개 시 고아 정리를 추가한다.
  - `changeHits`(1190): 리뷰 시점의 메인 트리 기준으로 그대로 둔다.
- `hooks/engine/run.ts`와 관련 타입: `NodeRun.worktree?: { path, base }`, 병합 충돌 오류 종류, 그에 맞는 복구 종류를 더한다.
- `hooks/engine/stages.ts`: 생성되는 리뷰·보안·커밋 노드를 격리하지 않음으로 표시한다. 병합이 미커밋 변경으로 끝나므로 프롬프트(`stages.ts:164`, `539`)는 그대로 맞다.
- `.claude-plugin/plugin.json`: `node_isolation`(`off` | `worktree`, 기본 `off`)과 `worktree_setup`(복사하거나 링크할 무시 파일 목록).
- `hooks/ui/`: 노드 행의 병합 상태, 인스펙터의 worktree 경로.
- 문서: `skills/planning/references/planning.md`(187, 259, 261), `README.md`, `docs/reference.md`.

**(b)에 필요한 테스트:**

- `tests/isolation.test.ts`(새 파일): argv 조립, 경로 이름, 병합 큐 순서, 충돌 분류, porcelain 파싱.
- `tests/runtime.test.ts`: 격리를 켜면 spawn에 `cwd`가 실린다. 끄면 지금과 같은 spawn 입력이 나온다(보존 검사).
- `tests/check-runtime.test.ts`, `tests/verification.test.ts`: 명령 검사와 파일 검사가 노드 worktree에서 돈다. 같은 argv라도 worktree가 다르면 줄을 세우지 않는다.
- `tests/completion.test.ts`: 완료한 순서대로 병합한다. 충돌하면 `failed`가 되고 worktree는 보존된다. `writes` 밖 변경은 거부된다.
- `tests/recovery.test.ts`, `tests/persistence.test.ts`: 재개하면 고아 worktree는 지우고 충돌로 보존한 것은 남긴다.
- `tests/ledger-runtime.test.ts`: review-fix 라운드의 fix diff가 병합 뒤 상태를 보여 준다.
- `tests/retention.test.ts`, `tests/footprint.test.ts`: 보존 정책이 남은 worktree를 지운다. 격리를 끄면 아무것도 만들지 않는다.
- 위 테스트는 `$.process.run`을 흉내 낸다. 실제 git 동작(`git apply` 충돌, 무시 파일 복사)은 구현 단계에서 한 번 실제 저장소로 확인한다.

## 2026-10-29 추가: main의 worktree 작업을 반영한 재검토

이 문서는 2026-10-28에 `origin/main`의 worktree 작업을 모르고 썼다. main에는 이미 아래가 있다. 이 절은 그 사실과, 그것이 비교와 권장안을 어떻게 바꾸는지만 적는다. 새로 잰 값은 없고, 숫자는 모두 `eval/baselines/worktree-spike-2.1.308.md`(`402034f`)에서 가져왔다.

### main에 있는 것

- **스파이크 `402034f`:** Claude Code 2.1.308에서 A(호스트 격리), B(플러그인이 worktree를 만들고 `cwd`로 실행), C(`WorktreeCreate` 훅에 플러그인이 만든 worktree를 넘김)를 실제로 돌려 본 기록이다. 기준선은 `eval/baselines/worktree-spike-2.1.308.md`. 플러그인 자체는 로드하지 않고 임시 프로브 플러그인으로 측정했다.
- **레시피 `8973088`:** `hooks/engine/isolation.ts`(어떤 노드를 격리할지, worktree 이름, 파일별 병합 판정)와 `hooks/engine/worktree.ts`(임시 인덱스로 메인 트리를 스냅숏해 `.claude/worktrees/` 아래 분리된 worktree를 만들고, 모든 변경 파일이 깨끗할 때만 `git merge-file`로 되돌려 병합). git은 주입한 함수로 실행한다. 아직 실행에는 연결되지 않았다. 곧 노드는 지금도 격리되지 않는다.
- **세션 폴더에서 실행 `8208bfa`:** 세션이 `EnterWorktree`로 worktree에 들어간 뒤 시작한 실행은 시작 때의 폴더를 기준으로 기록, 검사, git 읽기, diff를 한다.
- **worktree 인식 검사 `8076228`, `b3370d3`:** worktree의 쓰기를 메인 폴더 겹침 검사에서 빼고, 보드는 세션의 폴더에서 읽고, 핸드오프에 실행의 worktree를 적는다. 실행의 다음 노드를 시작할 때 worktree가 사라졌으면 분명한 오류로 멈춘다.

### 이 문서의 가정 중 바뀌는 것

| 이 문서(2026-10-28) | 스파이크가 보인 것 |
| --- | --- |
| (a)는 병합할 API가 없어서 곤란하다 | 호스트 격리는 HEAD에서 시작한다. 커밋하지 않은 `a.txt` 변경과 untracked 파일이 노드에 보이지 않고, 의존 노드가 받는 생산자 결과도 없다. 그래서 (a)는 병합 이전에 탈락이다. 격리가 끝난 worktree와 브랜치는 남았다(`WorktreeRemove` 없음). |
| (b)는 `$.agent.spawn({ cwd })`로 노드를 그 폴더에서 띄운다(API 근거 8) | 2.1.308은 spawn 인자의 `cwd`를 무시했다. 에이전트의 `pwd`는 세션 폴더였고 편집은 메인 체크아웃에 들어갔다. `agent.spawn` 훅에서 `next({ ...e, cwd })`로 다시 쓰면 worktree에서 돌았다. 지금 `startNode`가 spawn 인자로 넘기는 `cwd: rootOf(run)`도 같은 이유로 무시되므로, 세션이 worktree를 떠난 뒤의 실행은 이 훅 다시 쓰기로만 고칠 수 있다. |
| (b)의 기준은 HEAD 또는 스냅숏이다(결정 4) | 스냅숏이 맞고 메인 트리를 건드리지 않고 만들 수 있다(임시 `GIT_INDEX_FILE`). 이 레시피가 `8973088`에 이미 있다. |
| 병합은 `git apply`(결정 5) | 스파이크에서 `git apply --3way`는 인덱스가 작업 트리와 같아야 해서 모든 경우에 충돌로 쓸 수 없었고, 평범한 `git apply`는 한 줄 떨어진 형제 편집도 거부했다. `git merge-file`은 한 줄 이상 떨어진 변경은 깨끗이 합치고 인접하거나 같은 줄만 충돌로 알렸다. 레시피는 `git merge-file`을 쓴다. 충돌하면 실패로 두는 결정은 그대로다. |
| worktree는 프로젝트 밖에 둔다(결정 8) | 프로젝트 안(`.claude/worktrees/`)에 둬야 한다. `acceptEdits`에서 프로젝트 안은 Bash 읽기와 편집에 권한 요청이 없었고, 프로젝트 밖은 `ls -a`, `cat`, worktree 안의 Write에도 요청이 떴다. 안에 두면 스냅숏에서 이 폴더를 빼야 하며 레시피가 한다. |
| (b)의 비용은 git 호출 5번이라 부담일 수 있다 | 이 저장소 크기에서 노드당 스냅숏 55ms, worktree 생성 38ms, 적용 80ms, 제거 18ms(5회 중앙값). 파일 2,000개에 무시된 파일 20,000개인 합성 저장소에서는 81, 112, 145, 77ms. 인터랙티브 세션과 Windows는 재지 않았다. |

### 비교와 권장안에 미치는 영향

- **(a)는 완전히 탈락한다.** 이유가 "경로를 받을 API가 없다"에서 "HEAD에서 시작해 미커밋 작업과 의존 노드 결과를 못 본다"로 바뀌었고, 이는 측정한 사실이다. (c) `WorktreeCreate`는 동작하지만 격리된 노드가 모두 플러그인이 등록한 에이전트가 되어 노드의 `agent`와 시스템 프롬프트를 잃고, 세션의 모든 격리 에이전트에 훅이 발동한다.
- **(b)는 구현 위험이 줄었다.** 레시피(`8973088`)가 스냅숏, 분리된 worktree, 파일별 병합을 이미 갖췄고, 남은 일은 `startNode`와 검증, 리뷰·커밋 단계, 정리와 재개를 연결하는 것이다. 이 문서의 구현 목록에서 `hooks/engine/isolation.ts`는 새 파일이 아니라 이미 있는 파일이다. 또 `cwd`를 spawn 인자가 아니라 `agent.spawn` 훅에서 설정해야 하고, 호스트 경계가 없으므로 격리된 노드가 자기 worktree 밖에 Edit·Write 하는 것을 `tool.call`에서 거부해야 한다.
- **결론(두 문장).** "지금은 하지 않는다"는 유지한다. 2026-10-28의 이유(레인마다 전체 스위트를 둔 계획이 원인이고 교리가 고쳤다, 연결은 `register.ts` 전반을 바꾼다, D-X4가 O1을 먼저 하라고 했다)는 main의 작업으로 달라지지 않았고, 레시피가 아직 실행에 연결되지 않았으며 (b)로 바꿀 조건도 아직 생기지 않았기 때문이다. 다만 후보 (b)의 설계는 측정으로 굳었으므로, 조건이 생기면 새 조사 없이 `8973088`의 레시피를 `node_isolation: off` 기본값 뒤에 연결하는 것으로 시작하고, (a)는 조건과 무관하게 택하지 않는다.

## API 근거

모두 `.claude-plugin/types/claude-code/index.d.ts`의 해당 줄과 다시 대조했다.

1. 에이전트 정의는 `isolation?: 'worktree' | 'remote'`를 가진다. `worktree`는 자기 git worktree에서 돈다는 뜻이다. — `index.d.ts:555`(설명 552-554)
2. `$.agent.register(spec: AgentSpec)`가 플러그인의 에이전트 타입을 정의하고, 에이전트 파일이 가질 수 있는 모든 필드가 그대로 효력을 가진다. — `index.d.ts:3314`, `index.d.ts:461-467`
3. 등록한 타입은 다음 턴부터 Agent 도구가 디스패치하고, 이름은 `<plugin>:<name>`이다. — `index.d.ts:3290`
4. `AgentSpec.prompt`는 시스템 프롬프트 전체이며 세션의 프롬프트를 대체한다. — `index.d.ts:479`
5. `$.agent`에는 `spawn`, `list`, `register`만 있다. 다른 타입의 정의를 읽는 호출은 없다. — `index.d.ts:3279`, `index.d.ts:3288`, `index.d.ts:3314`
6. `AgentSpawnArgs`는 `prompt`와, 선택으로 `description`, `subagentType`, `model`, `name`, `cwd`만 받는다. `isolation`은 spawn 인자가 아니다. — `index.d.ts:251`
7. `$.agent.spawn`의 spawn은 백그라운드로 돌고, 서브에이전트가 시작되면 resolve된다. — `index.d.ts:248-249`, `index.d.ts:3269-3270`
8. `AgentSpawnInput.cwd`는 서브에이전트가 도는 디렉터리다. undefined면 부모의 디렉터리이고, 팀메이트에게는 적용되지 않는다. — `index.d.ts:403-408`
9. `agent.spawn` 훅은 `cwd`를 포함한 내용(prompt, description, subagentType, model, background, cwd)을 다시 쓸 수 있다. — `index.d.ts:257-259`
10. 에이전트 정의나 remote 격리는 `background`를 강제로 켤 수 있다. — `index.d.ts:331`
11. spawn 결과는 `model`, `agentId`, `teammateId`(또는 `deny`)뿐이고 worktree 경로가 없다. — `index.d.ts:422`
12. `turn.complete` 필드는 `answer`, `durationMs`, `isAborted`, `turnId`, `agentId`, `usage`이고 worktree 경로나 브랜치가 없다. — `index.d.ts:14279`
13. `$.agent.list()`의 `AgentInfo`에는 디렉터리나 worktree 필드가 없다. — `index.d.ts:125`
14. classic 이벤트는 settings 훅이 없어도 발생하고, 플러그인의 `classic.<Event>` 훅에 닿는다. — `index.d.ts:1270-1274`
15. `WorktreeCreate` 훅의 입력은 기본 필드와 `name`뿐이다. — `index.d.ts:15748-15751`
16. `WorktreeCreate` 결과의 `worktreePath`가 훅이 만든 worktree를 알리고, 비워 두면 세션이 평소처럼 git worktree를 만든다. — `index.d.ts:1381-1387`, `index.d.ts:1412`
17. `WorktreeRemove` 훅의 입력은 `worktree_path`를 가진다. — `index.d.ts:15753-15756`
18. 훅 입력의 `agent_id`는 서브에이전트 안에서 발생한 훅에만 있다. — `index.d.ts:863`
19. `$.process.run`은 셸 없이 argv로 실행한다. `cwd`는 기본이 세션의 디렉터리이고, 시간 제한은 기본 30초, 최대 10분이다. 시작하지 못하거나 시간을 넘기면 reject하고, git은 저장소 훅을 끈 채로 돈다. — `index.d.ts:3600-3616`
20. `ProcessRunInit.cwd`는 세션 기준 상대 경로나 절대 경로다. — `index.d.ts:8238-8242`
21. `$.session.cwd()`는 훅 안에서 읽으면 그 훅의 디렉터리(서브에이전트의 것)를 준다. — `index.d.ts:2829-2835`
22. `$.session.root()`는 세션이 시작한 곳이고, `/cd`나 worktree 이동이 있으면 그곳을 가리킨다. — `index.d.ts:2837-2843`
23. `$.session.repo().root`는 worktree 안에서도 메인 작업 트리의 루트다. — `index.d.ts:12184`
24. `$.fs`의 상대 경로는 세션 디렉터리 기준이다. (b)는 worktree 파일을 절대 경로로 읽어야 한다. — `index.d.ts:3317-3318`

선언으로 확인되지 않은 것(주장으로 쓰지 않는다): 호스트 격리 worktree를 만드는 위치와 브랜치 이름, 그것을 지우는 시점("변경이 없으면 자동 정리"는 Agent 도구 설명에만 있다), 2.1.311 삭제 버그 수정의 정확한 범위(`docs/external-benchmark-plan.md:104`의 기록).

## 결정할 것

1. **노드 격리를 지금 구현할까?** 권장: 아니다. (c)를 유지하고 O1을 먼저 한다(D-X4). `권장안`의 조건이 생기면 (b)로 다시 연다.
2. **구현한다면 (a)와 (b) 중 무엇?** 권장: (b). (a)는 worktree 경로를 받을 API가 없고(`index.d.ts:422`, `14279`), 노드의 `agent` 선택을 잃고, 최소 버전을 2.1.311로 올려야 한다.
3. **(b)의 기본값은?** 권장: `node_isolation: off`. 켠 실행에서만 worktree를 만들고, 끈 실행은 지금과 바이트 단위로 같은 spawn 입력을 쓴다.
4. **노드 worktree의 기준은 HEAD인가, 메인 트리 스냅숏인가?** 권장: 스냅숏이다. 실행 전 미커밋 변경과 앞서 병합된 생산자의 변경을 보려면 임시 인덱스로 만든 스냅숏 커밋이 필요하다. HEAD만 쓰면 의존 노드가 생산자 파일을 보지 못한다.
5. **병합 충돌은 3-way로 풀까, 실패로 둘까?** 권장: 실패로 둔다. `git apply`가 깨끗이 적용되지 않으면 노드를 `failed`(병합 충돌)로 두고 worktree를 보존한다. 자동 3-way 병합은 아무도 검증하지 않은 결과를 메인 트리에 남긴다.
6. **병합 뒤 메인 트리에서 노드 검사를 다시 돌릴까?** 권장: 파일 검사만 다시 돌린다. 명령 검사는 worktree 결과를 믿고, 통합 검증은 웨이브 뒤 노드가 맡는다(`planning.md:260-261`). 모든 명령 검사를 다시 돌리면 오늘의 줄서기가 되살아난다.
7. **리뷰·보안·커밋 노드도 격리할까?** 권장: 아니다. 이 노드들은 모든 생산자가 병합된 뒤 메인 트리에서 돌아야 지금의 프롬프트(`stages.ts:164`, `539`)가 그대로 맞는다.
8. **worktree를 어디에 둘까?** 권장: 프로젝트 밖, 예를 들어 시스템 임시 디렉터리 아래 `dag-worktrees/<runId>/<nodeId>`. 프로젝트 안에 두면 메인 트리의 `git status`와 리뷰 diff에 untracked 폴더로 섞일 수 있다. 밖에 둔 디렉터리를 `cwd`로 받은 서브에이전트의 편집에 권한 확인이 붙는지는 선언에 없으므로 구현 전에 실제 호스트로 확인한다.
9. **무시된 의존성(`node_modules`, `.claude-plugin/types/`)은 어떻게 갖출까?** 권장: 설정 `worktree_setup`에 경로를 받아 읽기 전용 심볼릭 링크로 건다. 노드가 설치를 다시 하지 않게 하고, 링크한 경로는 노드의 `writes`에 둘 수 없게 lint한다.
