# 제공자(Provider)

`zuku`와 `zukujs`는 같은 CLI의 두 이름입니다. 두 명령은 같은 제공자 설정·비밀 저장소·모델 캐시를 씁니다. 호출 이름에 따라 동작이나 저장 위치가 달라지지 않습니다.

기본 선택은 **ZUKU AI / `zuku/auto`** 입니다. 다른 제공자는 사용자가 명시적으로 선택할 때만 씁니다. 선택한 제공자가 실패해도 다른 제공자(Codex 포함)로 자동 전환하지 않습니다.

## 명령

```sh
zuku provider list                     # 전체 목록(● = 현재 선택)
zuku provider show <id>
zuku provider use <id>                 # TTY에서 <id>를 생략하면 목록에서 선택
zuku provider add [options]            # 사용자 지정 엔드포인트
zuku provider configure <id> [options]
zuku provider enable <id>
zuku provider disable <id>             # 현재 선택된 제공자는 비활성화 불가
zuku provider remove <id> --yes        # 사용자 지정 제공자만, 저장된 키도 함께 삭제
```

`zukujs provider ...`도 똑같이 동작합니다. 모든 명령은 `--json`을 지원하며 결과 데이터에는 자격 증명 값이 들어가지 않습니다.

### 비대화형 실행

stdin과 stderr가 모두 터미널일 때만 질문합니다. 파이프·CI에서는 질문 없이 필요한 값이 빠지면 `INVALID_INPUT`(종료 코드 2)으로 끝납니다. 진행 안내는 stderr, 결과 데이터는 stdout에만 씁니다.

### 사용자 지정 엔드포인트

```sh
zuku provider add --id local-ai --name "Local AI" --type openai-chat \
  --base-url http://localhost:8000/v1 --model my-model [--api-key-env LOCAL_AI_KEY]
```

| 옵션 | 설명 |
| --- | --- |
| `--id` | 소문자·숫자·`-`, 최대 64자. 기본 제공자 ID와 겹칠 수 없음 |
| `--type` | `openai-chat`(Chat Completions), `openai-responses`(Responses), `anthropic`(Messages) |
| `--base-url` | `https://` 또는 루프백 `http://127.0.0.1`·`localhost`·`[::1]`. 사용자 정보·쿼리·프래그먼트·`..`·인코딩된 경로 금지 |
| `--model` | 여러 번 지정 가능. 첫 모델이 기본 모델 |
| `--api-key-env` | 키를 담은 **환경 변수 이름**만 저장 |
| `--header-env Name=VAR` | 헤더 값을 환경 변수에서 읽음 |
| `--header-secret Name` | 헤더 값을 비밀 저장소에서 읽음(값은 `zuku auth login --provider <id> --header Name`으로 입력) |
| `--api-key-stdin` | 키를 파이프로 한 줄 입력 |
| `--disabled`, `--non-interactive` | 비활성 상태로 추가 / 질문하지 않음 |

TTY에서 옵션 없이 `zuku provider add`를 실행하면 형식 → 이름 → ID → Base URL → 모델 → (선택) API 키 순서로 묻습니다. 각 질문은 최대 3회 재입력 후 중단합니다.

사용자 지정 엔드포인트는 키를 사용하지 않아도 `(exp!)`·비공식으로 표시합니다. 모델 검색 API가 있다고 추측하지 않으므로 기본은 등록한 모델만 표시합니다. OpenAI 호환 `/models` 계약이 있는 주소는 설정의 `options.catalog: "openai"`를 명시해야 검색합니다(`none`으로 다시 끌 수 있음). 사용자 지정·로컬 모델을 써도 작업 범위·도구 제한은 그대로 적용됩니다.

### configure

```sh
zuku provider configure azure --base-url https://<resource>.openai.azure.com/openai/v1
zuku provider configure amazon-bedrock --region us-east-1 --model anthropic.claude-...
zuku provider configure google-vertex --project my-project --location us-central1
zuku provider configure cloudflare-ai-gateway --option accountId=<32-lowercase-hex> --option gatewayId=my-gateway
zuku provider configure openrouter --model anthropic/claude-x --default-model anthropic/claude-x
```

`--model`(추가), `--remove-model`, `--default-model`, `--api-key-env`/`--clear-api-key-env`, `--header-env`, `--header-secret`, `--remove-header`, 사용자 지정 제공자의 `--name`·`--type`·`--base-url`을 지원합니다. `--option KEY=VALUE`도 해당 제공자의 허용된 유한 옵션만 받습니다. 공식 고정 주소는 바꿀 수 없습니다(`PROVIDER_ENDPOINT_FIXED`). Azure는 공식 리소스 도메인만 허용하고, Cloudflare는 32자리 소문자 16진수 accountId와 1–64자리 영문·숫자·`_`·`-` gatewayId로 공식 주소를 구성합니다.

## 기본 제공자

| ID | 이름 | API 형식 | 주소 | 인증 |
| --- | --- | --- | --- | --- |
| `zuku` | ZUKU AI | `zuku` | `https://www.zuzunza.com/api/v1` | 게임 CLI OAuth `game-cli-device`, `login zuku --generate` |
| `openai` | OpenAI | `openai-responses` | `https://api.openai.com/v1` | API 키, `OPENAI_API_KEY` |
| `anthropic` | Anthropic | `anthropic` | `https://api.anthropic.com` | API 키, `ANTHROPIC_API_KEY` |
| `google` | Google Gemini | `gemini` | `https://generativelanguage.googleapis.com/v1beta` | API 키, `GEMINI_API_KEY`·`GOOGLE_GENERATIVE_AI_API_KEY` |
| `openrouter` | OpenRouter | `openai-chat` | `https://openrouter.ai/api/v1` | API 키, `OPENROUTER_API_KEY` |
| `amazon-bedrock` | AWS Bedrock | `bedrock` | 리전 기반(SDK) | AWS 자격 증명 체인, Bedrock API 키(`AWS_BEARER_TOKEN_BEDROCK`). `--region` 필수 |
| `google-vertex` | Vertex AI | `vertex` | 프로젝트·위치 기반(SDK) | Google ADC. `--project`, `--location` 필수 |
| `azure` | Azure OpenAI | `azure-openai` | 사용자 리소스(`*.openai.azure.com` 등) | API 키, `AZURE_OPENAI_API_KEY`·`AZURE_API_KEY` |
| `ollama` | Ollama | `ollama` | `http://127.0.0.1:11434` | 로컬(자격 증명 없음) |
| `lmstudio` | LM Studio | `openai-chat` | `http://127.0.0.1:1234/v1` | 로컬 |
| `mistral` | Mistral | `openai-chat` | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| `deepseek` | DeepSeek | `openai-chat` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| `groq` | Groq | `openai-chat` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `xai` | xAI | `openai-chat` | `https://api.x.ai/v1` | `XAI_API_KEY` |
| `alibaba` | Qwen(DashScope) | `openai-chat` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY`·`ALIBABA_API_KEY` |
| `togetherai` | Together AI | `openai-chat` | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |
| `fireworks` | Fireworks AI | `openai-chat` | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` |
| `cerebras` | Cerebras | `openai-chat` | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` |
| `sambanova` | SambaNova | `openai-chat` | `https://api.sambanova.ai/v1` | `SAMBANOVA_API_KEY` |
| `huggingface` | Hugging Face | `openai-chat` | `https://router.huggingface.co/v1` | `HF_TOKEN`·`HUGGINGFACE_API_KEY` |
| `vercel` | Vercel AI Gateway | `openai-chat` | `https://ai-gateway.vercel.sh/v1` | `AI_GATEWAY_API_KEY` |
| `cloudflare-ai-gateway` | Cloudflare AI Gateway | `openai-chat` | 공식 `gateway.ai.cloudflare.com`, accountId/gatewayId 필수 | API 키 |
| `codex` | Codex | `codex` | 어댑터 고정 | 자체 Codex OAuth `(exp!)` — 명시 선택·최초 로그인 `--experimental` |

`API 형식`은 어댑터 팩토리가 프로토콜 구현을 고르는 키입니다. OpenAI·Anthropic·Gemini·Bedrock·Vertex처럼 API가 다르면 어댑터가 실제 변환을 수행합니다(주소만 바꾸는 방식이 아님). 프로토콜 계약은 `docs/provider-api-contracts.md`(어댑터 담당)에 있습니다.

공통 형식 enum은 `zuku`, `openai-responses`, `openai-chat`, `anthropic`, `gemini`, `vertex`, `azure-openai`, `ollama`, `bedrock`, `codex`입니다. 기존 설정의 `zuku-native`, `anthropic-messages`, `bedrock-converse`, `codex-responses`는 읽을 때 정규화하며 새 설정은 공통 이름으로 저장합니다.

### 기능 메타데이터

각 제공자는 `streaming`, `tools`, `vision`, `reasoning`, `modelDiscovery`, `promptCaching`, `stageInference`를 `true`/`false`/`null`로 보고합니다. `null`은 "알 수 없음"이며 추측해서 채우지 않습니다. 모델별 값은 모델 정보에서 따로 봅니다([모델](models.md)).

### ZUKU AI(네이티브) 현재 경계

- `zuku/auto`는 서버 라우팅 별칭이며 CLI에 ZUKU 모델 카탈로그를 하드코딩하지 않습니다.
- 네이티브 어댑터는 보호된 게임 CLI OAuth 계정과 명시적 `games:generate` 범위로 `GET /oauth/game-agent/models` 및 고정된 5단계 실행 계약을 사용합니다. 레거시 AIST 사용자 JWT·환경 변수 토큰은 이 경로에 사용하지 않습니다.
- 설치본은 고정 스키마·지시문·skills 계약을 검사하고 실행 전 저장한 `runId`·`requestId`로 한 번만 POST합니다. 응답을 잃으면 같은 요청의 GET 상태를 확인하며 POST를 자동 재실행하지 않습니다. 계약 불일치·처리 중·결과 불명·보관 만료는 각 고정 오류로 구분합니다.
- `stageInference: true`는 구현된 계약의 지원 메타데이터입니다. 실제 인증·권한·서버 가용성을 보장하지 않습니다. 누락 권한·인증 실패·서버 503을 외부 제공자로 대신 실행하지 않습니다. 현재 계약에는 스트리밍·모델 도구 호출이 없으며 두 기능은 `false`입니다.

### 평가했지만 포함하지 않은 Kilo Code 제공자

Kilo Gateway·Apertis(다른 서비스 계정), GitHub Copilot(타사 API 사용용 공식 인증이 아님), Cohere·Perplexity·DeepInfra·NVIDIA·LLM Gateway·ZenMux 등은 이번 범위에서 제외했습니다. 필요하면 공식 계약을 확인한 뒤 어댑터 기술자와 카탈로그 항목을 추가합니다.

## 저장 위치

| 플랫폼 | 경로 |
| --- | --- |
| Linux/macOS | `~/.config/zukujs/providers/` (디렉터리 0700, 파일 0600) |
| Windows | `%LOCALAPPDATA%\ZukuJS\providers\` |

- `config.json`: 공개 설정(제공자·모델·환경 변수 이름·헤더 참조·비밀 없는 `authRevisions` UUID). 키·토큰이 들어 있으면 읽기/쓰기 모두 거부합니다(`PROVIDER_SECRET_IN_CONFIG`).
- `secrets.json`(POSIX) / `secrets.dpapi`(Windows): API 키·비밀 헤더 값. [제공자 인증](provider-auth.md) 참고.
- `models/<id>.json`: 자격 증명이 없는 모델 메타데이터 캐시.
- 모든 변경은 `.lock` 배타 잠금 → 읽기 → 검증 → 임시 파일(0600, `O_EXCL`) → `fsync` → `rename`으로 원자적으로 교체합니다. 동시에 실행한 여러 명령이 서로의 변경을 잃지 않습니다. 심볼릭 링크·하드 링크·다른 사용자 소유·그룹/기타 권한이 있는 파일은 거부합니다.

## 출처와 라이선스

설계 참고: Kilo Code (`Kilo-Org/kilocode`, MIT, 커밋 `76bcfd40be616a72f4697b3041565f322245b462`).

| 참고한 파일 | 적용한 패턴(코드 복사 없음, 독자 구현) |
| --- | --- |
| `packages/opencode/src/provider/provider.ts` `parseModel` | 첫 `/`에서만 나누는 `provider/model` 주소 |
| 같은 파일 `BUNDLED_PROVIDERS`, custom loaders | 지연 로딩 팩토리 맵(`apiType` → 어댑터), 분산 switch 금지 |
| `packages/opencode/src/auth/index.ts` | 제공자별 인증 레코드, 0600 저장 |
| `packages/opencode/src/provider/model-cache.ts`, `kilocode/provider/models-refresh.ts` | 제공자별 TTL 캐시, 진행 중 요청 공유, 강제 새로고침 |
| `packages/core/src/config/provider.ts` | 제공자 설정 스키마(모델·한도·헤더) |
| `kilocode/provider/cloud-auth.ts` | Bedrock 액세스 키/Vertex 서비스 계정 대 클라우드 자격 증명 체인 구분 |

공식 기본 주소·환경 변수 이름은 각 공급자 SDK가 npm에 배포한 기본값(`@ai-sdk/*`, `@openrouter/ai-sdk-provider`, `sambanova-ai-provider`; 버전은 `lib/provider-system/catalog.mjs` 주석)과 공급자 API 문서로 확인했습니다. 이 패키지의 라이선스는 바뀌지 않습니다.
