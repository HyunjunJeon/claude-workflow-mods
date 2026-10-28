# 노드 질문(O1)과 재작업 재사용(O3) 설계 비교

작성 2026-10-28. 기준: 브랜치 `fix/host-2-1-311-permission-gate`(`48555d7`), 설치된 Claude Code 2.1.312에서 만든 호스트 타입 `.claude-plugin/types/claude-code/index.d.ts`.
`docs/external-benchmark-plan.md`의 X4 산출물이다. 코드는 바꾸지 않았다. Orca 쪽 동작은 로컬 Orca CLI의 `orca skills get orchestration`과 `references/messaging-and-gates.md`에서 읽었다.
아래 `index.d.ts:<줄>`은 모두 위 타입 파일의 줄 번호이고, 플러그인 코드의 줄 번호는 `파일:줄`로 적는다.

## 문제

지금 노드는 질문할 수 없다.

- 노드 프롬프트가 허용하는 마지막 줄은 `DAG_NODE_STATUS: completed`와 `DAG_NODE_STATUS: failed: <reason>` 둘뿐이다(`hooks/engine/node-prompt.ts:87`–`90`). 생성되는 리뷰어 프롬프트는 "입력이 없으면 `failed: missing-input: <what>`으로 끝내고 질문하지 말라"고 못 박는다(`hooks/engine/stages.ts:176`).
- `parseOutcome`(`hooks/engine/node-prompt.ts:108`)은 `completed`·`failed`·`cancelled`만 만든다. 실패하면 `attemptRecovery`(`hooks/register.ts:1991`)가 Jev에게 복구 종류를 묻고, `clarification`이나 `missing-input`이 나오면 `recoverNode`가 자동 재시도를 거절한다(`hooks/engine/recovery.ts:36`). 노드는 `failed`로 남고 사람이 amend하거나 retry한다.
- 범위가 모호한 노드가 추측해서 `completed`로 끝내면 아무 기록도 남지 않는다.

**문제 크기(실측).** `.claude/dag/decisions/*.json` 8개 세션 파일(2026-10-19–2026-10-28)과 `.claude/dag/runs/*.json` 실행 체크포인트 21개를 셌다.

| 항목 | 값 |
| --- | --- |
| recovery 결정 기록 | 12건 |
| 적용된 선택(`selected`) | implementation 4, transient 1, manual 7(모두 `low-confidence`) |
| Jev의 최고 확률 선택 | implementation 11, transient 1, **clarification 0, missing-input 0** |
| clarification이 2위로 높았던 기록 | 2건: `dag_mvfxa06v_a3uv28/request-lint` 0.45, `dag_mvrskjyp_hfwvsq/flows-annotate` 0.39. 나머지 10건은 0.21 이하 |
| 체크포인트의 `node.recovery.kind` | implementation 3, transient 1, **clarification 0, missing-input 0** |
| 실제로 `failed: missing-input:`으로 끝난 노드 | 0. 검색에 걸린 문자열은 모두 프롬프트 안의 `<what>` 자리표시자였다 |

정의대로 세면 문제 크기는 **12건 중 0건**이다. 다만 질문이 있었으면 나았을 사례는 보인다. `dag_mvryfch8_kx1l20/layout-45`는 레이아웃 코드를 바꾸지 말라는 지시와 45% 폭 검사가 서로 맞지 않아 실패했다. 복구 사유는 "layout code not changed per instructions"였다. Jev는 이를 implementation(0.92)으로 분류했고 Opus로 다시 시도해 attempt 3에서야 끝났다. 추측한 뒤 `completed`로 끝난 노드는 기록에 남지 않으니 세지 못했다. `docs/external-benchmark-plan.md`의 D-X4는 O1을 먼저 하자는 이유로 "지금 실패의 원인으로 더 자주 보였다"를 들었는데, 이 기록은 그 근거를 뒷받침하지 않는다(결정할 것 1).

## 선택지

| | (a) 마지막 줄 `DAG_NODE_STATUS: blocked: <question>` | (b) 노드가 부르는 `ask` 액션 (`dag` 도구) | (c) 노드가 SendMessage로 메인에 질문 |
| --- | --- | --- | --- |
| 노드가 부를 수 있나 | 언제나. 답변 텍스트일 뿐이라 도구 목록이 좁은 에이전트 유형도 쓸 수 있다 | 일부만. 도구 목록에 `mcp__dag-workflow__dag`가 있는 유형만 부른다 | 모델은 보낼 수 있다. 다만 메인 대화를 어떤 주소로 부르는지는 타입에 없다 |
| 막는 질문이 되나 | 된다. 턴이 끝나고, 답을 받으면 같은 에이전트를 다시 깨운다 | 안 된다. 훅은 10초 안에 돌아와야 한다 | 안 된다. 전달은 큐에 넣는 것까지만이다 |
| 플러그인이 상태를 아나 | 안다. `turn.complete`에서 읽는다 | 안다 | 모른다. `session.send` 훅으로 가로채야 한다 |
| 바꿀 곳 | 상태 하나, 파서, 전이 함수 셋 | (a)에 도구 스키마를 더한 것 | 주소 규칙과 가로채기 훅 |

**(a) 마지막 줄.** 노드는 질문을 마지막 줄에 쓰고 턴을 끝낸다. 선택지와 기본값은 `## Question` 절에 적는다. 플러그인은 서브에이전트의 턴 끝을 `turn.complete`로 받는다. 거기에 `agentId`와 답변 전체가 들어 있다(`index.d.ts:14307`, `index.d.ts:416`). 턴이 끝난 이유는 `answer`·`aborted`·`refusal`·`error` 넷이고(`index.d.ts:14337`), `blocked`는 `answer`로 끝난 턴에서만 읽는다. 턴이 끝난 에이전트는 `completed` 상태다. 타입 주석에 따르면 이런 에이전트도 메시지를 받으면 같은 id로 다시 이어진다(`index.d.ts:564`, `index.d.ts:566`). 상태 이름은 이미 있다. `NodeState`에 `'blocked'`가 있고(`hooks/engine/types.ts:3`), `ACTIVE` 집합에 들어 있으며(`hooks/engine/run.ts:9`), 글리프 `◌`, 노란색, 영어·한국어 이름(`blocked`/`차단`)도 있다(`hooks/ui/view-model.ts:44`, `hooks/ui/view-model.ts:57`, `hooks/ui/i18n.ts:151`, `hooks/ui/i18n.ts:255`). 그런데 지금은 이 상태로 바꾸는 코드가 하나도 없다.

**(b) `ask` 액션.** 플러그인 도구는 "모델이 부를 수 있는 도구"로 등록된다(`index.d.ts:3135`, `index.d.ts:3149`). `tool.call` 입력에는 호출한 루프의 `agentId`가 붙는다(`index.d.ts:13617`, `index.d.ts:196`). 그래서 서브에이전트가 부르면 누가 불렀는지 알 수 있다. `dag` 도구 훅도 이미 `e.agentId`로 메인 루프와 서브에이전트를 나눈다(`hooks/register.ts:4342`). 이 노드의 세션에서도 `mcp__dag-workflow__dag`가 지연 도구 목록에 보였지만, 이것은 실행 중에 관찰한 것이지 타입 선언이 보장하는 것이 아니다. 도구 목록이 `Read, Grep, Glob, Bash`로 묶인 에이전트 유형(예: `code-reviewer`)은 이 도구를 부를 수 없다. 막는 질문으로는 만들 수 없다. 훅 하나는 자기 시간 10초를 쓸 수 있다(`index.d.ts:5289`). 이 시계는 `next(e)`나 `$` 호출을 기다리는 동안에만 멈추고, `$.clock` 대기는 예외다(`index.d.ts:5273`–`5274`). 패널이나 `/dag answer`를 기다리려면 플러그인 안의 Promise를 기다려야 하는데, 이것은 `$` 호출이 아니어서 10초를 넘긴다. 넘기면 훅은 없는 것으로 취급되고 "The dag tool failed"가 돌아간다. 사람을 기다리는 `$` 호출은 `$.ui.ask` 하나뿐이다(`index.d.ts:2466`). 하지만 `-p` 실행에서는 거절되고(`index.d.ts:2457`), 선택지를 2–4개만 받으며(`index.d.ts:2460`), Jev나 시간 초과로 답할 수 없다. 막지 않는 `ask`(질문을 기록하고 "이제 턴을 끝내라"고 돌려주기)는 도구 호출 하나를 더한 (a)에 지나지 않는다.

**(c) SendMessage.** 서브에이전트의 모델은 SendMessage를 보낼 수 있다(`index.d.ts:12312`–`12313`, 보낸 루프는 `index.d.ts:12300`). 그러나 받는 쪽 주소는 이름, 에이전트 id, 받은 `from` 주소뿐이고(`index.d.ts:12274`–`12275`), 메인 대화를 어떤 이름으로 부르는지는 타입 선언에 없다. 이 노드의 세션에서는 `main`이 주소로 보였지만, 이것은 실행 중에 관찰한 것이다. 게다가 전달은 받는 쪽 큐에 넣는 것까지이고 읽혔다는 뜻이 아니다(`index.d.ts:12333`). 막는 질문이 아니므로 노드는 계속 일하거나 턴을 끝낸다. 플러그인이 질문 상태를 알려면 `session.send` 훅으로 가로채야 한다.

## 답하는 경로

1. **패널의 사람.** 패널에 질문 카드를 띄운다. 실행 승인 블록처럼 선택지마다 Button을 둔다(승인 블록의 Approve/Reject는 `hooks/register.ts:3645`). 자유 답은 `/dag answer <run> <node> <text>`로 받는다. 이 명령은 `approve`처럼 composer에서 사람이 친 경우에만 받는다(`hooks/register.ts:4363`). 보드에서는 답할 수 없다. 보드 블록은 모두 보여 주기만 하는 종류이고(`hooks/engine/board-spec.ts`), "승인 블록"은 패널의 실행 승인 영역이 마지막 보드 제목을 가리키는 것이다(`hooks/register.ts:2860`, `hooks/ui/approval.ts`). 질문 카드는 그 옆에 둔다. 사람에게 알릴 때는 X1과 같이 `$.ui.notify`를 쓴다(`index.d.ts:2501`). `$.ui.ask`는 모달이라 하던 일을 끊고 `-p`에서 거절되므로 기본 경로로 쓰지 않는다.
2. **메인 대화의 모델(조정자).** Orca에서 작업자의 `ask`에 `reply`로 답하는 쪽은 조정자다. 여기서 조정자는 메인 대화다. 질문이 생기면 `submitRunNews`로 메인 모델에게 알리고, 모델은 `dag` 도구의 `answer` 액션으로 답한다. 모델은 이미 amend와 프롬프트를 바꾼 retry로 노드의 과제를 바꿀 수 있으므로, 답을 허락해도 권한이 새로 늘지 않는다. 다만 사람이 거절한 실행(`rejected`)에는 답할 수 없고, 노드가 `Needs: person`으로 표시한 질문(권한, 비용, 외부 변경)에도 답할 수 없다.
3. **Jev.** Jev는 정해진 선택지 중 하나를 고르는 분류기다(`JevQuestion`의 `type: 'choice'`, `hooks/engine/jev.ts:17`). 그래서 노드가 선택지를 준 질문에만 답할 수 있다. 새 요청 종류 `question`을 만들어 선택지를 criteria로 넘기고, 결과는 다른 Jev 결정처럼 decisions 로그에 남긴다. `Needs: person` 질문에는 답하지 않는다. recovery의 clarification 기준이 "사람의 결정이 필요한 것"이므로 그 기준과 같다.
4. **시간 초과 기본값.** 노드가 `Default:`를 적었다면 정해진 시간이 지난 뒤 그 값을 답으로 보내고 `by: timeout`으로 기록한다. Orca에서도 `ask`가 시간을 넘기면 질문 하나가 지워지지 않고 남고, 작업자는 같은 메시지 ID로 이어 간다. 여기서는 질문이 체크포인트에 남고, 답을 받으면 같은 에이전트가 이어 간다.

**아무도 답하지 않을 때.**
- 대화형 세션: 노드는 `blocked`로 남는다. `blocked`는 `ACTIVE`에 들어 있으므로 실행은 `running`이고, 관계없는 노드는 계속 돈다. 시간 초과가 오면 기본값이 있을 때 그 값을 보낸다. 없으면 노드를 `failed: clarification: <question>`으로 끝내고 `recovery.kind = clarification`을 Jev 호출 없이 바로 기록한다. 그 뒤는 지금처럼 amend나 retry로 처리한다.
- `-p` 세션: 기다릴 수 없다. `$.ui.ask`는 거절되고(`index.d.ts:2457`), `-p` 세션은 마지막으로 살아 있는 에이전트가 멈추고 58–440 ms 뒤 끝난다는 관측이 있다(`hooks/register.ts:1641`). `blocked` 노드에는 살아 있는 에이전트가 없다. 그래서 질문이 들어오는 즉시 Jev(선택지가 있고 기준을 넘을 때), 기본값, `failed: clarification` 순서로 하나를 고른다.

## 이어가기

**같은 에이전트를 이어 쓸 수 있다(타입 근거).** `$.agent`에는 `spawn`·`list`·`register`만 있고 보내기나 재개하는 메서드는 없다(`index.d.ts:3264`, `index.d.ts:3279`, `index.d.ts:3288`, `index.d.ts:3314`). 재개는 `$.session.send`가 맡는다(`index.d.ts:2937`, `index.d.ts:2949`). 주소가 `{ agentId }`이고 그 서브에이전트가 이미 끝났다면, transcript에서 그 메시지로 재개된다(`index.d.ts:12246`–`12247`). 끝난 에이전트도 같은 id로 재개될 수 있다(`index.d.ts:564`). 재개되면 `agent.spawn` 훅에 `resume.agentId`가 붙어 들어온다. 이때 훅은 거절만 할 수 있고, 내용을 바꾸면 무시된 뒤 한 번 보고된다(`index.d.ts:380`–`389`). 재개된 실행이 끝나면 같은 `agentId`로 `turn.complete`가 한 번 더 온다. 실행 한 번이 턴 하나이기 때문이다(`index.d.ts:14307`–`14308`). `send`는 큐에 넣으면 끝나고(`index.d.ts:12333`), 실패하면 `isDelivered: false`와 이유를 돌려준다(`index.d.ts:12351`). 플러그인에 비슷한 선례가 둘 있다. 백그라운드 대기는 노드를 `running`으로 두고 에이전트 매핑을 남겨 같은 에이전트의 다음 턴 끝을 기다린다(`hooks/register.ts:1698`). 기존 `send` 액션은 실행 중인 노드에 `$.session.send`로 메시지를 보낸다(`hooks/register.ts:2643`).

**흐름.**
1. `onAgentDone`(`hooks/register.ts:1731`)이 `blocked`를 읽는다. 검증은 하지 않는다(산출물이 아직 없다). 보고서는 쓴다. 노드는 `blocked`가 되고 `agentId`와 `question`을 남긴다. `claimCompletion`(`hooks/register.ts:1607`)이 `agentRuns` 매핑을 지운 상태로 둔다.
2. 답이 오면 노드를 `running`으로 되돌린다. `attempt`는 늘리지 않는다. `agentRuns`에 다시 등록한 뒤 `$.session.send({ to: { agentId }, text })`로 `<answer by="person|model|jev|timeout">…</answer>`와 "과제를 이어 하고 같은 상태 줄로 끝내라"를 보낸다.
3. 같은 `agentId`의 다음 `turn.complete`는 지금과 똑같이 처리한다. 검증과 복구도 그대로 돈다.
4. `isDelivered: false`이면(재개 실패, 다른 프로세스 등) 새 시도로 바꾼다. 노드를 `pending`으로 두고 `clarifications`에 질문과 답을 남긴다. `buildNodePrompt`가 이것을 `<clarifications>` 블록으로 프롬프트에 넣는다. 이전 시도가 일부 파일을 바꿔 놓았을 수 있다는 것도 함께 알린다.

**카운터와 지문.**
- `attempt`: 같은 에이전트를 재개하면 그대로 둔다. `attempt`는 `markRunning`이 에이전트를 띄울 때마다 세는 값이다(`hooks/engine/run.ts:97`). 새 시도로 대체하면 지금처럼 1 늘어난다.
- 복구 예산(`MAX_AUTO_RECOVERIES = 2`, `hooks/engine/recovery.ts:9`): 질문과 답은 실패가 아니므로 쓰지 않는다. 시간 초과로 `failed: clarification`이 되면 Jev를 부르지 않고, `recoverNode`가 거절하니(`hooks/engine/recovery.ts:36`) 예산도 줄지 않는다.
- review-fix 라운드(`MAX_REVIEW_FIX_ROUNDS = 1`, `hooks/engine/rework.ts:13`): `reworkRun`은 정산된 실행만 받는다(`hooks/engine/run.ts:292`). `blocked`가 남아 있는 동안에는 라운드가 시작되지 않는다. 라운드가 다시 돌린 생산자도 질문할 수 있고, 그 답은 그 시도의 것이다.
- `clarifications`의 수명: retry, 자동 복구, review-fix를 거쳐도 남긴다. 선언된 과제가 같기 때문이다. amend로 지문이 바뀐 노드는 `freshNode`로 새로 만들어지므로(`hooks/engine/run.ts:384`) 그때 버린다. 질문이 옛 프롬프트에 대한 것이었기 때문이다.
- 지문: `nodeFingerprint`는 prompt·category·agent·dependsOn·verify·writes만 본다(`hooks/engine/definition.ts:101`). 질문과 답은 `NodeRun`에 두므로 지문도 `findReusable`도 바뀌지 않는다.
- 모델: 재개할 때는 모델을 바꿀 수 없다(`index.d.ts:383`). 재개는 같은 시도를 이어 가는 것이라 문제가 없다. 새 시도로 대체할 때만 라우팅을 다시 한다.
- 질문 수: 한 시도에 2개까지 받는다. 세 번째 `blocked`는 `failed: clarification`으로 다룬다. 질문과 답이 끝없이 오가는 것을 막기 위해서다.
- 플러그인 자신의 `agent.spawn` 훅(`hooks/register.ts:4078`)은 학습 목록을 프롬프트에 붙인다. 재개할 때 이렇게 바꾸면 무시되고 보고 줄이 남으므로, `e.resume`이 있으면 `next(e)`를 그대로 불러야 한다.
- 확인하지 못한 것: `claude --resume` 뒤나 다른 프로세스에서도 transcript 재개가 되는지. `$.agent.list()`는 끝난 서브에이전트 항목을 얼마 뒤 지운다(`index.d.ts:3284`–`3285`). `send` 주석은 transcript에서 재개한다고 하지만, 목록에서 빠진 뒤에도 그런지는 적혀 있지 않다. 4번의 새 시도 대체가 이 경우를 덮는다.

## 권장안

**설계.** 노드가 `DAG_NODE_STATUS: blocked: <question>`(선택지·기본값·`Needs: person`은 `## Question` 절)으로 턴을 끝내면, 기존에 쓰이지 않던 `blocked` 상태로 둔다. 사람(패널 버튼, `/dag answer`), 메인 모델(`answer` 액션), 헤드리스에서는 Jev, 끝으로 시간 초과 기본값 중 먼저 온 답을 `$.session.send({ to: { agentId } })`로 같은 에이전트에 보낸다. 전달되지 않으면 질문과 답을 프롬프트에 넣은 새 시도로 대체한다.

**바꿀 파일.**
- `hooks/engine/types.ts`: `NodeRun.question?: { text; options?; default?; needsPerson?; askedAt }`, `NodeRun.clarifications?: { question; answer; by: 'person' | 'model' | 'jev' | 'timeout'; at }[]`. `'blocked'`는 그대로 쓴다.
- `hooks/engine/node-prompt.ts`: 상태 줄 안내에 `blocked`를 더한다(생성 리뷰어·검증자·commit 노드는 빼서 지금 계약을 유지한다). `parseOutcome`이 `blocked`와 `## Question` 절을 읽게 하고, `buildNodePrompt`가 `<clarifications>`를 넣게 한다.
- `hooks/engine/run.ts`: `NodeOutcome`에 `blocked`를 더한다. `markBlocked`(running→blocked, `agentId` 유지), `resumeAnswered`(blocked→running, `attempt` 그대로, 답 기록), `requeueAnswered`(blocked→pending, 새 시도)를 만든다. `snapshotOf`는 `question`을 내보낸다.
- `hooks/engine/jev.ts`: `questionRequest(run, node)`. 선택지를 criteria로 넘긴다.
- `hooks/engine/tool-spec.ts`: `answer` 액션(`run_id`, `node_id`, `answer`) 스키마와 설명. 설명 길이는 2048자 한도 안에서 다시 잰다.
- `hooks/register.ts`: `onAgentDone`의 `blocked` 분기, 시간 초과 타이머(`$.clock.after`, `index.d.ts:3555`), 헤드리스 즉시 처리, `handleTool`의 `answer`, 사람 전용 `/dag answer`, 알림, `agent.spawn` 훅의 `e.resume` 통과.
- `hooks/ui/inspector-model.ts`, `hooks/ui/view-model.ts`, `hooks/ui/band.ts`, `hooks/ui/i18n.ts`: 질문 줄, 선택지 버튼, band 문구(영어·한국어).
- `docs/reference.md`, `README.md`: 상태, 명령, 시간 초과 동작.

**필요한 테스트.**
- `tests/engine.test.ts`: 마지막 줄의 `blocked`만 읽고 본문 중간의 것은 무시한다. 선택지와 기본값을 파싱한다. 전이 셋의 결과. 재개하면 `attempt`가 그대로이고 대체하면 1 는다. `blocked` 동안 `deriveStatus`는 `running`이다. cancel이 `blocked`를 에이전트를 멈추지 않고 끝낸다. `clarifications`가 retry·복구·rework 뒤에도 남고 지문이 바뀐 amend에서는 지워진다.
- `tests/runtime.test.ts`(또는 새 `tests/questions-runtime.test.ts`, `tests/control-harness.ts:139`의 `session.send` 목을 다시 쓴다): `blocked` 턴 끝에 검증이 돌지 않는다. composer의 `/dag answer`가 `session.send({ to: { agentId } })`를 부르고, 같은 `agentId`의 다음 `turn.complete`가 검증을 거쳐 노드를 끝낸다. `isDelivered: false`이면 `<clarifications>`가 든 새 시도가 시작된다. 시간 초과에 기본값이 있으면 그 값을 보내고, 없으면 `failed`와 `recovery.kind = clarification`이 되며 Jev를 부르지 않는다. 헤드리스에서 Jev가 기준을 넘으면 그 선택지, 못 넘으면 기본값, 그것도 없으면 실패. 모델의 `answer`는 `rejected` 실행과 `Needs: person` 질문에서 거절된다. `agent.spawn` 훅이 `resume` 입력을 바꾸지 않는다. 세 번째 질문은 실패로 다룬다.
- `tests/inspector.test.ts`, `tests/view.test.ts`: 질문 줄과 버튼, 영어와 한국어 문자열.

**일부러 뺀 것.**
- (b) 막는 `ask` 도구와 (c) SendMessage 경로. 위 이유로 막는 질문이 되지 않는다.
- Orca의 결정 게이트(`gate-create`). Orca도 게이트는 조정자가 가진 DAG 결정에만 쓰고 작업자 `ask`의 답으로 쓰지 말라고 한다. 실행 단위 승인은 이미 있다.
- 생성 리뷰어, 보안 검증자, commit 노드의 질문. `failed: missing-input` 계약을 그대로 둔다.
- 대화형 세션에서 Jev가 답하는 것. 사람보다 먼저 답해 버리기 때문이다.
- 보드에서 답하기, 여러 개를 고르는 답, 턴 중간의 질문.
- O3 구현(아래).

## O3: 재작업에 끝난 에이전트 재사용

**API가 있다.** `$.agent` 네임스페이스에는 없고(`index.d.ts:3264`), `$.session.send({ to: { agentId } })`가 끝난 서브에이전트를 transcript에서 재개한다(`index.d.ts:12246`–`12247`). 끝난 에이전트(`completed`·`failed`·`killed`)도 메시지를 받으면 같은 id로 다시 이어질 수 있다(`index.d.ts:564`). 재개는 `agent.spawn`에 `resume`이 붙어 들어오고(`index.d.ts:380`–`389`), 끝나면 같은 id로 `turn.complete`가 다시 온다(`index.d.ts:14307`–`14308`). `docs/external-benchmark-plan.md`가 "아직 찾지 못했다"고 적은 API가 바로 이것이다.

**지금 플러그인은 쓰지 않는다.** `reworkRun`은 생산자의 `agentId`를 지우고(`hooks/engine/run.ts:302`) 새 에이전트를 띄운다. `send` 액션은 실행 중이 아닌 노드를 `node_not_continuable`로 거절한다(`hooks/register.ts:2646`).

**재사용하면 달라지는 것.**
- 좋은 점: 생산자가 자기가 바꾼 내용과 판단을 기억한 채 리뷰 지적만 받는다. 맥락을 다시 읽는 비용이 사라진다.
- 비용: 재개할 때 모델을 바꿀 수 없다(`index.d.ts:383`). 그래서 implementation 복구가 하는 Opus 승격(`hooks/engine/recovery.ts`)을 쓸 수 없다. transcript가 길어진 채로 이어지고, 새 에이전트가 주는 독립된 시각도 잃는다.
- 확인하지 못한 것: 다른 프로세스나 `claude --resume` 뒤에도 재개되는지. O1의 재개 경로와 같은 문제다.

**판정: API는 있음. 구현은 보류한다.** O1의 재개 경로(`send` → `resume` → 같은 id의 `turn.complete`)를 수동 smoke test와 런타임 테스트로 먼저 증명한다. 그 뒤에 `reworkRun`이 생산자의 `agentId`를 남기고, 시작 경로가 새로 띄우기 전에 `send`를 먼저 해 보고 전달되지 않으면 새로 띄우게 바꾼다. 보류하는 이유는 API가 없어서가 아니라 O1과 같은 메커니즘을 두 번 따로 검증하지 않기 위해서다.

## API 근거

이 문서가 하는 호스트 API 주장마다 읽은 선언의 줄을 적었다.

1. `turn.complete`는 서브에이전트 루프의 턴 끝마다 그 서브에이전트 id(`agentId`)를 싣고 온다. 그 루프의 실행 한 번이 턴 하나다 — `index.d.ts:14307` (주석 14307–14308, 필드 `agentId?` 14314)
2. 플러그인이 띄운 서브에이전트의 답은 같은 `agentId`를 실은 그 에이전트의 `turn.complete`다 — `index.d.ts:416`
3. 턴이 끝나는 이유는 `answer`·`aborted`·`refusal`·`error` 넷이다 — `index.d.ts:14337`
4. 에이전트 상태 중 끝난 상태는 `completed`·`failed`·`killed`이고, 메시지를 받으면 같은 id로 재개될 수 있다 — `index.d.ts:564` (타입 `index.d.ts:566`)
5. `$.session.send`는 다른 에이전트나 세션에 평문 메시지를 보내고, `{ agentId }` 주소를 받는다 — `index.d.ts:2949` (주석 2937–2947)
6. `{ agentId }`로 보낸 메시지는 끝난 서브에이전트를 transcript에서 재개한다 — `index.d.ts:12246` (주석 12246–12247, 타입 `SessionSendAddress` 12232)
7. 전달됨은 받는 쪽 큐에 들어갔다는 뜻일 뿐 읽혔다는 뜻이 아니다 — `index.d.ts:12333`
8. 전달되지 않으면 `isDelivered: false`와 `reason`을 돌려준다 — `index.d.ts:12351`
9. `$.agent` 네임스페이스에는 `spawn`·`list`·`register`만 있다. 에이전트에게 보내거나 재개하는 메서드는 없다 — `index.d.ts:3264` (`spawn` 3279, `list` 3288, `register` 3314)
10. `$.agent.list()`는 끝난 서브에이전트 항목을 얼마 뒤 목록에서 지운다 — `index.d.ts:3285` (주석 3284–3285)
11. 재개된 실행은 `agent.spawn`에 `resume.agentId`를 싣고 오고, `next`는 같은 id로 끝난다 — `index.d.ts:387` (주석 380, 필드 389)
12. 재개 때 훅은 거절만 할 수 있고, 내용 키(prompt, model 등)를 바꾸면 무시되고 한 번 보고된다 — `index.d.ts:383`
13. `$.ui.ask`는 사람에게 AskUserQuestion 대화상자로 묻고 고른 라벨이나 자유 입력을 돌려준다 — `index.d.ts:2466`
14. `$.ui.ask`는 닫히면 거절되고 `-p` 실행에서도 거절된다 — `index.d.ts:2457`
15. `$.ui.ask`의 선택지는 2–4개다 — `index.d.ts:2460`
16. 훅 하나의 시간 예산은 10,000 ms다 — `index.d.ts:5289`
17. 이 시계는 `next(e)`나 `$` 호출을 기다리는 동안 멈추지만 `$.clock` 대기에서는 멈추지 않는다 — `index.d.ts:5273` (주석 5273–5274)
18. `$.tool.register`는 모델이 다음 프롬프트부터 부를 수 있는 `mcp__<plugin>__<name>` 도구를 등록한다 — `index.d.ts:3149` (주석 3135)
19. `tool.call` 입력에는 `AgentLoop`가 들어 있어, 서브에이전트 루프의 호출이면 그 루프 id가 실린다 — `index.d.ts:13617` (`AgentLoop.agentId` 주석 196, 필드 203)
20. SendMessage는 메인 대화에서도, 서브에이전트나 팀원 루프에서도 모델이 부를 수 있다 — `index.d.ts:12312` (주석 12312–12313)
21. `session.send` 입력의 `agentId`는 보내는 루프의 id다 — `index.d.ts:12300`
22. SendMessage의 받는 쪽은 이름, 에이전트 id, 받은 `from` 주소로 적는다. 메인 대화의 이름은 정해 두지 않았다 — `index.d.ts:12274` (주석 12274–12275)
23. `$.ui.notify`는 사람의 알림 채널로 시스템 알림을 띄운다 — `index.d.ts:2501`
24. `$.clock.after`는 `ms` 뒤 `fn`을 한 번 부르고 `cancel()`로 멈출 수 있다 — `index.d.ts:3555`

## 결정할 것

1. **문제 크기가 12건 중 0건인데 O1을 지금 구현할까?** 추천: 먼저 재개 경로 smoke test를 한 번 한다. 대화형 세션에서 끝난 노드 에이전트에 `$.session.send({ to: { agentId } })`를 보내, 그 에이전트가 재개되고 같은 id로 `turn.complete`가 오는지 본다. 되면 권장안을 구현한다. D-X4의 근거 문장은 "실패 원인으로 더 자주 보였다"에서 "기록에는 0건, 추측으로 끝난 노드는 셀 수 없음"으로 고친다. 재개가 되면 O3도 함께 열리므로 비용 대비 이득은 남는다.
2. **상태 이름: 쓰이지 않던 `blocked`를 다시 쓸까, `asking`을 새로 만들까?** 추천: `blocked`를 쓴다. 타입, `ACTIVE`, 글리프, 색, 두 언어 이름이 이미 있다. 마지막 줄의 낱말과도 같다.
3. **메인 대화의 모델이 답해도 될까?** 추천: 된다. Orca의 조정자 `reply`와 같고, 모델이 이미 가진 amend·retry 권한보다 넓지 않다. 단 `rejected` 실행과 `Needs: person` 질문은 사람만 답한다.
4. **Jev는 언제 답할까?** 추천: 헤드리스 세션에서, 노드가 선택지를 준 질문에만 답하게 한다. 기준은 `jev_recovery_confidence`(0.9)를 같이 쓴다. 새 설정은 실제 질문 결정이 쌓인 뒤 따로 나눈다.
5. **시간 초과 길이와 설정 여부.** 추천: 대화형 15분을 상수로 둔다. 기본값이 있으면 보내고, 없으면 `failed: clarification`으로 끝낸다. 헤드리스는 0분(즉시)이다. 설정 항목은 쓰임이 확인된 뒤 더한다.
6. **한 시도에 받는 질문 수.** 추천: 2개. 세 번째는 실패로 다룬다.
7. **amend 뒤 질문과 답을 남길까?** 추천: 지문이 바뀐 노드에서는 버리고, 바뀌지 않은 노드에서는 남긴다.
8. **생성 리뷰어·보안 검증자·commit 노드도 질문하게 할까?** 추천: 아니다. 이 노드들은 입력이 없을 때 `failed: missing-input`으로 끝나야 다음 판정(재작업, 커밋 거절)이 바로 이어진다.
9. **O3 순서.** 추천: O1의 재개 경로가 런타임 테스트와 smoke test를 통과한 뒤 같은 메커니즘으로 review-fix 생산자 재개를 붙인다. 전달 실패 시 새로 띄우는 대체 경로는 남긴다.
