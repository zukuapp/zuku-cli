# 제공자 인증

```sh
zuku auth list [--provider <id>]
zuku auth login [--provider <id>] [options]
zuku auth logout [--provider <id>]
```

`zukujs auth ...`와 같은 저장소를 씁니다. `--provider`를 생략하면 TTY에서는 목록에서 고르고, 비대화형에서는 기존 `zukujs login`과 같이 `zuku`를 사용합니다. 기존 `zukujs login zuku`, `zukujs login codex --experimental` 명령도 그대로 동작합니다.

## 인증 방식 메타데이터

모든 인증 방식은 `{ id, name, type, official, experimental, unofficial }`로 표시됩니다. `unofficial`은 `!official`입니다. `(exp!)` 표시는 `experimental`에서만 나오며 이름 문자열로 판단하지 않습니다. ANSI 터미널에서는 `(exp!)`만 주황색이고, `NO_COLOR`, `TERM=dumb`, 파이프 출력, `--json`에는 색이 없습니다.

| ID | 종류 | 공식 | 실험적 | 저장 위치 |
| --- | --- | --- | --- | --- |
| `api-key` | 공식 API 키 | 예 | 아니요 | 비밀 저장소 |
| `environment` | 환경 변수 | 예 | 아니요 | 환경 변수(이름만 설정에 저장) |
| `aws-credential-chain` | 클라우드 자격 증명 체인 | 예 | 아니요 | AWS SDK 기본 체인 |
| `aws-bedrock-api-key` | Bedrock API 키 | 예 | 아니요 | 비밀 저장소 / `AWS_BEARER_TOKEN_BEDROCK` |
| `google-adc` | Google ADC | 예 | 아니요 | Google 기본 자격 증명 |
| `local` | 로컬 | 예 | 아니요 | 없음 |
| `game-cli-device` | ZUKU 게임 CLI OAuth 디바이스 코드 | 예 | 아니요 | CLI 자체 보호 계정 저장소, `games:generate` 필수 |
| `codex-oauth` | Codex OAuth | **아니요** | **예 `(exp!)`** | CLI 자체 Codex 저장소(최초 옵트인) |
| `custom-api-key`, `custom-env` | 사용자 지정 엔드포인트 키 | 아니요 | 예 `(exp!)` | 비밀 저장소 / 환경 변수 |
| `custom-none` | 사용자 지정 주소, 자격 증명 없음 | 아니요 | 예 `(exp!)` | 없음 |

Codex 메타데이터는 루트 `lib/experimental.mjs`의 `CODEX_AUTH_METHOD`를 읽어 오지만, 우리 Codex 연동은 어떤 값이 와도 항상 `official: false`, `experimental: true`로 고정됩니다. 사용자 지정 엔드포인트는 서비스의 공식 인증인지 알 수 없으므로 기본이 실험적입니다.

## 키 입력

비밀 값은 명령 인수로 받지 않습니다. `--api-key`, `--token`, `--secret`, `--password` 같은 옵션과 키 모양의 인수(`sk-…`, `AKIA…`, `eyJ….` 등)는 `AUTH_SECRET_ARGUMENT`로 거부하며 값은 오류에 다시 나오지 않습니다.

```sh
zuku auth login --provider openai                      # TTY: 숨김 입력(에코 없음, Ctrl-C 취소)
printf '%s\n' "$KEY" | zuku auth login --provider openai --api-key-stdin   # 파이프 한 줄, 16 KiB·30초 제한
zuku auth login --provider openai --api-key-env MY_OPENAI_KEY             # 변수 이름만 저장
zuku auth login --provider local-ai --header X-Signed   # 비밀 헤더 값을 숨김 입력
zuku auth login --provider openai --verify             # 저장 후 어댑터의 인증 확인(네트워크)
```

- 비대화형에서 입력 방법을 주지 않으면 `AUTH_INPUT_REQUIRED`로 바로 끝납니다. 질문하지 않습니다.
- 파이프 하나에는 비밀 하나만 받습니다(`--api-key-stdin`과 `--header`를 함께 쓸 수 없음).
- 로컬(Ollama·LM Studio)은 저장할 것이 없어 `not-required`, Vertex는 `credential-chain`을 반환합니다.
- 네이티브 생성은 `zuku login zuku --generate`로 `games:upload games:create games:publish games:generate`를 승인해야 합니다. 기존 3권한 계정은 `scope-required`로 표시하며 생성 요청을 거부합니다. 레거시 사용자 JWT·환경 변수 토큰은 네이티브 생성에 사용하지 않습니다.
- Codex는 `zuku login codex --experimental`로 처음 연결하고 동의를 자체 보호 저장소에 기록합니다. 동의가 유지되는 동안 에이전트 실행마다 같은 플래그를 반복할 필요는 없으며, 메타데이터는 항상 Experimental·비공식입니다. 개인 Codex 로그인 상태나 다른 도구의 키 파일을 가져오지 않습니다.

## 자격 증명 사용 순서

선택된 제공자 하나에 대해서만 읽습니다(다른 제공자의 환경 변수·저장 항목은 읽지 않음).

1. 비밀 저장소의 API 키
2. `--api-key-env`로 지정한 환경 변수
3. 제공자의 공식 환경 변수(위 표의 순서)
4. 클라우드 자격 증명 체인(Bedrock: AWS 체인, Vertex: ADC) — SDK는 해당 제공자를 선택했을 때만 어댑터가 지연 로딩
5. 로컬·자격 증명 없는 사용자 지정 엔드포인트

이 순서는 사용할 인증 방식을 요청 전에 선택합니다. 선택된 방식의 인증이 실패해도 다른 방식·제공자로 넘어가지 않습니다. 네이티브와 Codex는 일반 API 키 선택 순서에 들어가지 않으며 각자의 보호 계정 저장소만 사용합니다.

## 상태 값

`auth list`는 값이 아니라 상태만 보여 줍니다: `configured`, `scope-required`(ZUKU 생성 권한 없음), `environment`(변수 이름만 표시), `credential-chain`(원격 인증 확인 전), `not-required`, `not-configured`, `unknown`. 보호 계정의 로컬 상태만 읽으며 네트워크를 쓰지 않습니다.

## 비밀 저장소

- POSIX: `~/.config/zukujs/providers/secrets.json`, 현재 사용자 소유 0600 일반 파일, 0700 디렉터리. 심볼릭·하드 링크, 다른 소유자, 그룹/기타 권한은 `SECRET_STORE_UNSAFE`.
- Windows: `%LOCALAPPDATA%\ZukuJS\providers\secrets.dpapi`. `lib/accounts/windows-protected-store.mjs`의 `readProtectedStore(filePath)`·`writeProtectedStore(filePath, plaintext)`·`withProtectedStoreLock(filePath, operation)` 파일 API를 사용합니다(CurrentUser DPAPI + 사용자 SID ACL). 보호 모듈을 쓸 수 없으면 평문으로 대신 저장하지 않고 실패합니다. Windows 실기 검증은 Windows CI에서 수행하며 Linux 모의 검증을 실제 DPAPI 검증으로 간주하지 않습니다.
- 공개 설정(`config.json`)에는 비밀 헤더도 `{ "source": "secret" }` 또는 `{ "source": "env", "env": "VAR" }` 참조로만 기록합니다.
- 키는 로그, 오류 메시지, `--json` 출력, 모델 입력, 어댑터 기술자(descriptor)에 들어가지 않습니다. 어댑터에는 열거되지 않는 내부 `getCredentials({signal})`만 전달하며 각 네트워크 작업 직전에 갱신합니다. 반환 형태는 `{kind:'api-key',apiKey,headers?}`, `{kind:'bearer',accessToken,headers?}`, `{kind:'none',headers?}`, `{kind:'cloud-chain',configuration}`입니다. 이 값과 getter는 공개 클라이언트·이벤트·설정으로 내보내지 않습니다.
- 인증 변경은 비밀을 포함하지 않는 `authRevisions` UUID로 캐시를 무효화합니다. 진행 중 클라이언트는 키·헤더·설정·계정 generation이 바뀌면 새 계정으로 요청을 이어가지 않고 중단합니다. 동일 계정의 OAuth 토큰 갱신은 허용합니다.

## 오류 코드

| 코드 | 의미 |
| --- | --- |
| `AUTH_SECRET_ARGUMENT` | 비밀 값을 인수로 전달함 |
| `AUTH_INPUT_REQUIRED` | 비대화형에서 입력 방법이 없음 / 입력 시간 초과 |
| `AUTH_SECRET_INVALID` | 줄바꿈·제어 문자·크기 초과 |
| `AUTH_REQUIRED` | 선택한 제공자의 자격 증명이 없음 |
| `AUTH_SESSION_CHANGED` | 시작 후 인증·연결 설정이나 네이티브 계정이 바뀜 |
| `AUTH_EXPERIMENTAL_OPT_IN` | Codex 최초 로그인 동의와 `--experimental`이 없음 |
| `ZUKU_GENERATE_SCOPE_REQUIRED` | ZUKU 계정에 명시적 생성 권한이 없음 |
| `AUTH_DELEGATE_UNAVAILABLE` | 기존 계정 명령/로그아웃 연동을 이 설치본에서 쓸 수 없음 |
| `SECRET_STORE_UNAVAILABLE`, `SECRET_STORE_UNSAFE` | 보호 저장소 없음 / 파일 안전성 위반 |
