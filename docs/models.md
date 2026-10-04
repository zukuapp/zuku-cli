# 모델

## 주소

모델은 `<provider>/<model>`로 지정합니다. **첫 번째 `/`에서만** 나누므로 모델 ID 안의 `/`는 그대로 유지됩니다.

```text
zuku/auto
openai/<model>
anthropic/<model>
google/<model>
openrouter/<vendor>/<model>      # provider=openrouter, model=<vendor>/<model>
ollama/llama3.2:3b
```

- 제공자 ID: 소문자·숫자·`-`, 최대 64자.
- 모델 ID: 최대 256자, 각 `/` 구간은 영문·숫자와 `. _ : @ + ~ = , -`만 허용. 공백·제어 문자·`%`·`\`·빈 구간·`.`/`..` 구간은 거부합니다(`MODEL_ADDRESS_INVALID`).

## 명령

```sh
zuku model list [--provider <id>] [--refresh]   # 기본: 현재 제공자
zuku model refresh [--provider <id>]            # 캐시 무시하고 다시 조회
zuku model use <provider/model>                 # TTY에서 생략하면 목록에서 선택
zuku model info [<provider/model>] [--refresh]  # 기본: 현재 모델
zuku model current
```

`zukujs model ...`도 같은 설정을 바꿉니다. `model use`는 현재 제공자와 모델을 함께 바꿉니다.

## 목록의 출처

| `source` | 의미 |
| --- | --- |
| `builtin` | 네이티브 별칭(`zuku/auto`) |
| `configured` | 사용자가 `provider add/configure --model`로 등록 |
| `discovered` | 제공자의 모델 목록 API가 실제로 돌려준 항목 |

- 모델 목록 API가 있는 제공자는 실제 API로 조회합니다(어댑터 담당). 없는 경우 CLI가 목록을 지어내지 않습니다. 등록한 모델만 보이며, 등록되지 않은 모델 선택은 `MODEL_UNAVAILABLE`로 실패합니다.
- 조회 결과는 `discovery.status`로 표시합니다: `fresh`(방금 조회), `cached`(TTL 내 캐시), `stale`(조회 실패, 이전 캐시 사용), `unavailable`(조회 불가 — `error`에 고정 코드), `unsupported`.
- 캐시는 제공자별 `models/<id>.json`에 15분 동안 유지합니다. API 형식·주소·옵션·헤더 참조·인증 방식·공개 인증 revision·ZUKU 계정 generation이 바뀌면 캐시를 쓰지 않습니다. 캐시에는 키·토큰·비밀 헤더나 그 값의 해시가 없습니다.
- 환경 변수 인증은 현재 프로세스에만 있는 임의 식별자로 카탈로그를 구분하므로 다른 실행이나 다른 계정의 캐시를 재사용하지 않습니다. AWS/Google 기본 자격 증명 체인은 계정 식별자를 추측하지 않고 매번 조회하며 디스크 카탈로그 캐시를 사용하지 않습니다.
- 로그아웃·생성 권한 누락·인증 실패 시 이전 계정의 오래된 카탈로그를 반환하지 않습니다. 진행 중 요청도 인증 revision이 바뀌면 이전 카탈로그를 현재 캐시에 게시할 수 없습니다.
- 같은 프로세스에서 동시에 요청한 목록 조회는 한 번의 요청을 공유합니다. 실패한 조회를 자동 재시도하지 않습니다.

## 모델 정보

```json
{
  "id": "gpt-x", "address": "openai/gpt-x", "name": "GPT X", "provider": "openai",
  "capabilities": { "streaming": null, "tools": true, "vision": null, "reasoning": null, "promptCaching": null },
  "contextWindow": 128000, "maxOutputTokens": null, "inputCost": null, "outputCost": null,
  "source": "discovered"
}
```

토큰 한도·가격·기능은 제공자 API나 사용자가 등록한 값이 있을 때만 채웁니다. 모르는 값은 `null`이며 추측하지 않습니다. 이름에 제어 문자가 있거나 다른 제공자를 가리키는 항목, 잘못된 ID는 버립니다(최대 5000개).

## 에이전트 실행과의 연결

루트 에이전트는 `createProviderRuntime().resolveStageProvider({ model, signal })`로 선택된 제공자 하나에 묶인 클라이언트를 받습니다.

- `model`을 주지 않으면 `model use`로 선택한 값, 그것도 없으면 `zuku/auto`.
- 선택된 제공자가 비활성화되었거나 모델을 알 수 없으면 실패합니다. 다른 제공자로 바꾸지 않습니다.
- `runStage({ stage, instructions, input, outputSchema, maxOutputBytes, signal, onEvent? })`는 선택한 모델 ID를 붙여 어댑터로 보내고 `{ provider, stage, model, output, usage, experimental, unofficial }`를 돌려줍니다. `experimental`/`unofficial`은 선택된 인증 방식의 신뢰할 수 있는 메타데이터에서 정합니다.
- 단계 입력에 해당 제공자의 키·비밀 헤더 값이 들어 있으면 보내기 전에 `CREDENTIAL_IN_MODEL_INPUT`으로 차단합니다.
- 추론 전에 유한 JSON 스키마를 검증하며 외부 참조·복잡한 정규식·지원하지 않는 스키마를 거부합니다. 출력은 최대 1,600,000바이트로 제한하고 같은 스키마 및 호스트의 추가 검증을 통과해야 합니다. 호스트 검증이 비동기이면 완료를 기다립니다.
- 비공개 `onEvent`(호환 별칭 `onDelta`)는 원래 추론에서 실제로 받은 `text-delta`, 안전한 숫자 `usage`, 실제 `finish`만 전달합니다. UI를 위해 두 번째 추론을 만들거나 최종 응답에서 가짜 델타를 만들지 않습니다. reasoning 텍스트·원격 원본 객체를 버리고 분할된 자격 증명도 가립니다. 콜백은 취소 가능하며 10초 내 완료되지 않으면 해당 추론을 중단합니다.
- `finish`는 결과 검증 후 한 번만 전달합니다. 네이티브 ZUKU 계약은 현재 스트리밍이나 모델 도구 호출을 제공하지 않습니다.
