<a href="https://zukuapp.github.io/docs/">
  <img src="https://raw.githubusercontent.com/zukuapp/.github/main/profile/assets/developer-hero.png" alt="Trecillo × ZUKU 개발자 문서" width="760">
</a>

# zuku-cli: ZukuJS 진단과 Jump CLI 시제품

ZukuJS의 `help`, `version`, `status`, `diagnostics`를 제공합니다. Jump 프로젝트용 `create`, `validate`, `package`, `upload`는 **미구현 시제품**이며 `NOT_IMPLEMENTED` 오류와 종료 코드 1을 반환합니다. 파일 생성·검증·압축·업로드를 수행하지 않습니다.

> **배포 상태:** `zuku-cli`은 npm 레지스트리에 게시되지 않았습니다. `npm install -g zuku-cli`을 설치 절차로 사용하지 마세요.

## 현재 동작

| 명령 | 현재 구현 | 작업에 사용할 수 있나요? |
| --- | --- | --- |
| `help` / `system.help` | 명령 안내 | 예. |
| `version` / `system.version` | ZukuJS·CLI 버전 | 예. 두 버전을 구분합니다. |
| `status` / `app.status` / `diagnostics` | 로컬 설정 상태 | 예. 기본 실행은 네트워크를 사용하지 않습니다. |
| `status --check-api` | 공개 목록·선택적 사용자 인증 확인 | 예. 아래 인증·조회 범위를 확인하세요. |
| `create <name>` | `NOT_IMPLEMENTED` 오류 | 아니요. |
| `validate <path>` | `NOT_IMPLEMENTED` 오류 | 아니요. |
| `package <path>` | `NOT_IMPLEMENTED` 오류 | 아니요. |
| `upload <path>` | `NOT_IMPLEMENTED` 오류 | 아니요. |

공통 별칭과 `--json` 응답은 ZukuJS의 `zuku-command/1`을 따릅니다. 성공은 `success/data/meta`, 실패는 `success:false/error/meta`로 출력합니다. 성공 JSON은 stdout, 오류 JSON은 stderr입니다. 내부 서비스의 `ok/data` 봉투는 공개 API 응답으로 인정하지 않습니다.

ZukuJS 런타임 정체성은 플랫폼의 `config/zukujs.json`과 같은 원본 바이트를 [`lib/zukujs-metadata.json`](lib/zukujs-metadata.json)에 묶습니다. CLI 패키지 버전 `0.1.0`은 런타임 버전과 별개입니다. 브라우저의 화면·성능·테마 명령은 CLI 환경에 없으므로 지원한다고 표시하지 않습니다.

## 로컬에서 살펴보기

Node.js 18 이상에서 저장소를 내려받아 도움말을 확인할 수 있습니다.

```sh
git clone https://github.com/zukuapp/zuku-cli.git
cd zuku-cli
node index.mjs --help
node index.mjs version --json
node index.mjs status --json
node index.mjs diagnostics --check-api --json
```

`npm run lint`는 소스 구문을 검사하고 `npm test`는 로컬 HTTP fixture, 서명 없는 공개 bearer 경계, 자격 증명 권한, 오류 정보 차단, 명령 응답을 확인합니다. 검증은 운영 API를 호출하지 않습니다. Linux에서 확인했으며 macOS·Windows 실행은 별도로 확인해야 합니다.

## 공개 API와 사용자 인증

API 주소는 `https://www.zuzunza.com/api/v1`로 고정합니다. `--check-api`는 `GET /billing/catalog`만 익명으로 호출하며, 사용자 토큰이 있을 때 `GET /auth/me`도 확인합니다. 목록에는 사용자 토큰을 보내지 않습니다. `/auth/me`는 서버의 기존 세션 갱신 처리를 포함할 수 있지만 CLI는 응답 쿠키를 저장하거나 토큰을 자동 갱신하지 않습니다. 결제·구독·업로드·관리자 API는 호출할 수 없습니다.

사용자 bearer 토큰은 `ZUKU_ACCESS_TOKEN` 환경 변수에서 읽습니다. 토큰을 명령 인수나 공개 파일에 넣지 마세요. Linux/macOS에서는 기본 `~/.config/zuku/credentials.json` 또는 절대 경로 `ZUKU_CREDENTIALS_FILE`을 사용할 수 있습니다. 파일은 현재 사용자 소유의 일반 파일, 권한 `0600`이어야 하며 심볼릭 링크를 허용하지 않습니다. 내용은 `access_token` 한 필드만 받습니다. Windows에서 파일 권한 검증은 지원하지 않으므로 환경 변수를 사용하세요. CLI가 로그인 토큰을 생성하거나 저장하지는 않습니다.

진단 결과에는 인증 설정 유무·인증 상태·목록 개수만 포함하고 계정 ID·이메일·원문 응답·토큰·쿠키를 포함하지 않습니다. 서비스 HMAC 비밀키는 CLI에서 읽거나 전송하지 않습니다. 요청은 3초·응답 64KiB로 제한하고 리디렉션이나 자동 재시도를 허용하지 않습니다. Ctrl+C는 진행 중인 조회를 취소합니다.

## 지금 사용할 수 있는 공개 도구

- **HTML5 ZIP → ZWF2 `.zwf`:** [`zwf`](https://github.com/zukuapp/zwf)의 컴파일·검사 명령을 사용하세요.
- **Jump ZIP 메타데이터:** [`zuku-engine-next2d`](https://github.com/zukuapp/zuku-engine-next2d)의 [매니페스트 스키마](https://github.com/zukuapp/zuku-engine-next2d/blob/main/schemas/jump-manifest.schema.json)와 패키지 검증기를 확인하세요.
- **API 모델:** [`zuku-api`](https://github.com/zukuapp/zuku-api)의 OpenAPI 계약을 읽으세요. 계약 문서만으로 인증·업로드 서비스가 제공된다고 가정하지 마세요.

`zwf`의 ZWF2 매니페스트와 Jump ZIP의 `jump.manifest.json`은 서로 다른 형식입니다. 한 도구의 필드를 다른 형식에 그대로 사용하지 마세요.

## 구현에 기여하기

명령을 구현할 때는 실제 입출력과 실패 조건을 먼저 정하고 테스트를 추가해 주세요. 특히 검증 실패나 업로드 실패를 성공으로 보고하지 않도록 해야 합니다. Jump 패키지 계약을 바꾸면 소유 저장소의 스키마와 테스트도 함께 검토하세요.

공개 문서의 시작점은 [ZUKU 개발자 허브](https://github.com/zukuapp/.github/blob/main/docs/README.md)입니다.
