# 상태줄 HUD 안내

[README로 돌아가기](../README.md)

모든 명령과 코드 경로는 저장소 루트 기준입니다.

## 상태줄 HUD

`statusline/`은 플러그인과 따로 쓰는 Claude Code 상태줄(`statusLine`) 스크립트입니다. 플러그인은 메인 상태줄을 정할 수 없어서(플러그인 `settings.json`은 `agent`와 `subagentStatusLine`만 받습니다) 사용자 설정에 직접 넣습니다.

```
Opus 5.5 xhigh │ claude-workflow-mods │ ⎇ main ↑1
ctx ▰▰▰▰▰▰▰▰▱▱ 84% 840k/1M │ 5h 91% ↻2h57m │ cache 2m
 ⚠ 컨텍스트 84% · 품질 저하 구간 → /compact 또는 새 세션  │  ⚠ 캐시 2분 후 만료 · 이어갈 거면 지금 보내세요
```

- 첫 줄은 모델과 effort(fast 모드면 `fast`), 프로젝트와 하위 디렉터리, git 브랜치와 ahead/behind, 워크트리, PR 번호와 리뷰 상태, `--agent` 이름, 기본이 아닌 출력 스타일입니다. 세션 제목, 비용, 경과 시간, 변경 줄 수, 변경 파일 수는 그리지 않습니다.
- 둘째 줄은 컨텍스트, 사용 한도, 프롬프트 캐시입니다.
  - 컨텍스트는 막대, 사용률, 토큰/창 크기입니다. 50% 이상 노란색, 65% 초과 빨간색으로 답의 품질이 떨어지는 구간을 보여 줍니다.
  - 5시간·7일 사용 한도(게이트웨이의 `spend` 포함)는 70% 미만이면 숨기고, 70% 이상인 창만 초기화까지 남은 시간과 함께 노란색, 85% 이상 빨간색으로 그립니다.
  - 캐시는 식기까지 남은 시간입니다. 1시간 TTL은 10분 이하 노란색, 3분 이하 빨간색이고, 5분 TTL은 2분과 1분이 기준입니다. 이미 식었으면 빨간 `cold`이고, 다음 요청이 캐시를 처음부터 다시 씁니다.
  - 캐시 미스가 나면 그다음 요청 전까지(최대 10분) 캐시 바로 옆에 빨간 바탕으로 원인이 붙습니다: `cache 50m  ⚠ 캐시 깨짐: 1시간 넘게 쉬어 만료`. 미스는 Claude Code가 판정합니다. 요청이 캐시에서 읽어야 했던 양의 95%보다 적게 읽고 모자란 양이 2,000토큰 이상이면 미스입니다(압축이나 오래된 도구 결과 정리 직후는 제외). 다음 요청은 미스가 다시 쓴 캐시를 읽으므로 그때 표시가 사라집니다. 세션의 요청 수는 실행 사이에 `$TMPDIR/claude-hud-<session_id>.json`에 기억합니다. 원인은 Claude Code가 진단한 이름을 한국어로 옮긴 것입니다(`도구 목록 바뀜 (+2 −0)`, `모델 바뀜`, `effort 바뀜`, `auto 모드 전환` 등). 모델·effort·auto 모드(shift+tab)·thinking 전환, MCP·플러그인 도구 변경은 대화 중에 바꾸면 캐시를 깹니다. 폭이 좁으면 7일·5시간 한도 다음으로 빠집니다.
- 셋째 줄은 경고가 있을 때만 빨간 바탕으로 나타납니다.
  - 컨텍스트 80% 이상: `/compact`나 새 세션을 권합니다.
  - 캐시가 빨간 구간(1시간 TTL 3분 이하, 5분 TTL 1분 이하): 이어갈 거면 지금 보내라고 알립니다.
- 터미널 폭(`COLUMNS`)을 넘으면 덜 중요한 항목(출력 스타일, 7일 한도, 5시간 한도, 캐시 미스 순)부터 빼고, 남은 줄은 끝을 자릅니다. `NO_COLOR`가 있으면 색을 쓰지 않습니다.
- 값이 아직 없는 항목(첫 응답 전의 사용 한도, 캐시)은 그리지 않습니다. git은 `--no-optional-locks`와 `--untracked-files=no`로 500ms 안에서만 읽습니다.

```bash
bun statusline/install.ts              # ~/.claude/statusline-hud.mjs를 만들고 statusLine을 그 파일로 바꿈
bun statusline/install.ts --uninstall  # 설치 전 statusLine으로 되돌리고 statusline-hud.mjs를 지움
bun statusline/install.ts --print      # 파일을 쓰지 않고 넣을 값만 출력
```

설치는 `hud.ts`와 그것이 가져오는 코드를 `Bun.build`로 한 파일로 묶어 `~/.claude/statusline-hud.mjs`에 씁니다. 설정 명령은 이 파일을 가리키므로 설치한 뒤에는 저장소를 옮기거나 지워도 HUD가 돌고, `statusline/`을 고쳤다면 다시 설치해야 반영됩니다. 기존 설정 파일은 `settings.json.hud-backup`으로, 기존 `statusLine` 값은 `statusline-hud.previous.json`으로 보관합니다(모두 `~/.claude/`, `CLAUDE_CONFIG_DIR`을 따름). 설치는 `bun`으로 실행해야 하고, 명령에는 `bun`의 절대 경로가 들어갑니다. 묶은 파일은 Node 24로도 돕니다. `refreshInterval: 60`이라 세션이 쉬고 있어도 남은 시간과 경고가 1분마다 갱신됩니다. 설정 파일이 바뀌면 열려 있는 세션에도 바로 적용됩니다.

### Orca 연동

HUD는 받은 입력을 바이트 그대로 `~/.orca/agent-hooks/claude-statusline.sh`에 넘깁니다. Orca가 상태줄로 설치하는 이 스크립트는 화면에 아무것도 출력하지 않고 사용 한도와 세션 정보를 Orca 앱으로 보내므로, HUD로 바꿔도 Orca 연동은 그대로입니다. 넘기는 프로세스는 분리(detached)해서 띄우므로 HUD는 Orca의 전송(최대 1.5초)을 기다리지 않고, Claude Code가 다음 갱신에서 HUD를 끊어도 전송은 끝까지 갑니다. `refreshInterval: 60` 때문에 쉬고 있는 세션도 1분마다 Orca로 보냅니다(Orca 스크립트는 15초 안의 반복만 거릅니다).

- 다른 스크립트로 넘기려면 `CLAUDE_HUD_CHAIN=<스크립트 경로>`를, 끄려면 `CLAUDE_HUD_CHAIN=off`를 `settings.json`의 `env`에 넣습니다. 스크립트가 없으면 넘기지 않습니다.
- Orca는 `statusLine.command`에 `agent-hooks/claude-statusline`이 들어 있으면 자기가 설치한 값으로 보고 다시 쓰거나 지웁니다. 그 밖의 명령은 사용자 값으로 보고 건드리지 않습니다. 그래서 Orca 경로는 명령이 아니라 `hud.ts` 안에 있습니다. 명령에 이 경로를 넣지 마세요.

받은 JSON을 보려면 `CLAUDE_HUD_DEBUG=<파일>`을 줍니다. 손으로 확인할 때는 `echo '{"model":{"display_name":"Opus"}}' | bun statusline/hud.ts`처럼 실행합니다.
