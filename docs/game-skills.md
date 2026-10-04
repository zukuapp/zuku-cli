# 필수 게임 스킬 팩

`zukujs agent`의 모든 모델 단계는 CLI에 함께 배포되는 **ZukuJS 게임 스킬 팩**(`zukujs-game-skills` 1.0.0)을 반드시 적용합니다. 다섯 스킬은 이 프로젝트를 위해 새로 작성한 원본이며, 외부 스킬이나 다른 서비스의 런타임·샌드박스 코드를 복사하지 않았습니다.

| 스킬 | 단계 | 출력 | 코드 게이트가 확인하는 것 |
| --- | --- | --- | --- |
| [`game-design`](../skills/game-design/SKILL.md) | `design` | 설계 계획 | 플레이어 동사, 닫힌 코어 루프, 패배·리셋 조건과 리셋 입력, 충돌 없는 키 매핑, DOM HUD·시작/게임 오버 메뉴, 원본 에셋 목록, 엔진 선택 이유, 시뮬레이션/렌더 경계, 저장·디버그·성능 예산 |
| [`game-architecture`](../skills/game-architecture/SKILL.md) | `architecture` | 모듈 구조 | 사용 가능한 엔진만 선택, `simulation`/`render`/`input`/`boot` 역할, 경계 목록 일치, `status`/`score`/`tick` 상태, 계획과 같은 입력 매핑, `zuku-hooks/1` |
| [`game-implementation`](../skills/game-implementation/SKILL.md) | `implementation` (+수정 1회) | `src/` 파일 전체 | 경로·확장자·크기, 명령·네트워크·비밀 값 금지, 인라인 스크립트 금지, 로컬 스크립트·상대 import만, HUD/메뉴 id가 DOM에 존재, 순수한 시뮬레이션 모듈, 입력 모듈의 키 문자열, 훅, 에셋 파일, 엔진 일치 |
| [`game-playtest`](../skills/game-playtest/SKILL.md) | `playtest` | 입력 스크립트 | 계획에 있는 동작만, 1.5–12초, 관찰할 HUD id 유효 — 판정은 실제 브라우저 관찰로만 |
| [`game-publish`](../skills/game-publish/SKILL.md) | `publish` | 스토어 메타데이터 | 제목·설명·태그 길이와 중복, 링크·이메일·비밀 값 금지, 키보드 플레이 가능(`pc`), 포인터가 모든 동작을 지원할 때만 모바일/태블릿 |

## 강제 방식

1. **고정된 무결성.** `lib/agent/skill-lock.json`에 각 `SKILL.md`의 버전과 SHA-256(줄바꿈 CRLF→LF 정규화), 팩 전체 SHA-256이 고정되어 있습니다. 실행마다 다섯 파일을 모두 읽어(링크 불가, 64 KiB 이하) 검증하고, 하나라도 다르면 모델 호출 전에 `AGENT_SKILL_INTEGRITY`로 멈춥니다.
2. **끌 수 없음.** `--no-skills` 같은 옵션은 없으며 알 수 없는 옵션으로 거부됩니다. 컨텍스트 주입으로도 스킬 경로나 잠금 파일을 바꿀 수 없습니다(테스트용 `loadSkillPack({ root })`는 오케스트레이터가 쓰지 않습니다).
3. **전문 주입.** 각 단계 지시문에는 해당 스킬의 본문 전체와 이름·버전·SHA-256이 들어갑니다. 요청은 신뢰하지 않는 입력으로 표시되며 규칙을 바꿀 수 없습니다.
4. **영수증 대조.** 모델은 `skill_receipt`에 정확한 이름·버전·SHA-256을 되돌려야 합니다. 다르면 단계가 거부됩니다. 이것은 일관성 확인일 뿐 적용 증거가 아니며, `true` 같은 값이나 "적용했다"는 주장은 스키마에서 거부됩니다.
5. **결과로 판정.** 적용 여부는 위 표의 코드 게이트와 실제 브라우저 플레이테스트가 산출물 자체를 검사해 판정합니다.
6. **기록.** 영수증의 모든 단계 항목에 `{ name, version, sha256 }`과 게이트 코드가 남고, 실행 전체에 팩 버전·SHA-256이 남습니다.

## 스킬을 고칠 때

스킬 본문을 바꾸면 `version`을 올리고 잠금 파일을 다시 만든 뒤 테스트를 실행합니다.

```sh
node -e "import('./lib/agent/skills.mjs').then(async m => process.stdout.write(JSON.stringify(await m.computeSkillLock({ version: '1.0.1' }), null, 2) + '\n'))" > lib/agent/skill-lock.json
node --test tests/agent-units.test.mjs
```

게이트(`lib/agent/gates.mjs`)와 스킬 규칙은 함께 바뀌어야 합니다. 스킬에만 있는 규칙은 강제되지 않는 권고입니다.
