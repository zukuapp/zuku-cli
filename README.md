<a href="https://zukuapp.github.io/docs/">
  <img src="https://raw.githubusercontent.com/zukuapp/.github/main/profile/assets/developer-hero.png" alt="ZukuJS 개발자 문서" width="760">
</a>

# @zukujs/cli: ZukuJS 명령줄 도구

ZukuJS 게임 프로젝트를 만들고(`create`), 검사하고(`validate`), 재현 가능한 ZWF2 패키지로 묶고(`package`), ZUKU 서비스에 **초안**으로 올리는(`upload`) 명령줄 도구입니다. 명령 이름은 `zukujs`, 패키지 버전은 0.2.0입니다.

> **배포 상태:** `@zukujs/cli`는 npm 레지스트리에 게시되지 않았습니다. 아래처럼 소스 체크아웃에서 실행하세요.

## 설치 (소스 체크아웃)

Node.js 22 이상이 필요합니다.

```sh
git clone https://github.com/zukuapp/zukujs-cli.git
cd zukujs-cli
npm install
npm link
zukujs --help
```

## 빠른 사용

```sh
zukujs create catch-game          # 플레이 가능한 캔버스 게임 프로젝트
cd catch-game
zukujs validate .                 # 로컬 검사
zukujs package . --format zwf     # dist/<name>-<version>.zwf
zukujs upload . --verify          # 업로드 후 초안 생성(공개하지 않음)
```

`create`·`validate`·`package`는 네트워크를 쓰지 않고 프로젝트 코드를 실행하지 않습니다. `upload`는 운영 서비스 `https://www.zuzunza.com/api/v1`에 실제로 업로드하고 초안을 만듭니다. 초안은 공개 목록에 나타나지 않지만 업로드된 `/uploads/...` 파일 URL은 공개 주소입니다. 공개(publish)는 이 도구가 하지 않습니다.

## 인증 요약

- 토큰 순서: `ZUKUJS_ACCESS_TOKEN` → `ZUKU_ACCESS_TOKEN`(이전 이름) → 자격 증명 파일(`ZUKUJS_CREDENTIALS_FILE` → `ZUKU_CREDENTIALS_FILE` → `~/.config/zukujs/credentials.json`).
- 이전 기본 경로 `~/.config/zuku/credentials.json`은 자동으로 읽지 않습니다.
- 파일은 현재 사용자 소유, 권한 `0600`, 링크 없음, `access_token` 키 하나만 허용합니다.
- 토큰을 명령 인수·프로젝트 파일·로그에 넣지 마세요. 업로드 영수증(`.zukujs/receipts`, 권한 `0600`)에도 자격 증명은 저장하지 않습니다.

자세한 규칙: [인증과 서비스 엔드포인트](docs/authentication.md)

## 문서

| 문서 | 내용 |
| --- | --- |
| [시작하기](docs/getting-started.md) | 요구 사항, 설치, 첫 프로젝트 |
| [명령 참조](docs/commands.md) | 명령·플래그, 응답 형식, 종료 코드 |
| [인증과 서비스 엔드포인트](docs/authentication.md) | 토큰 기밀성, 자격 증명, 호출 API |
| [프로젝트 작업 흐름](docs/project-workflow.md) | `zukujs.json`, 패키지 규칙, ZWF2, 초안 업로드, 영수증 |
| [이름 규칙과 마이그레이션](docs/naming.md) | `zuku-cli`/`zuku`/`ZUKU_*`에서 옮기기 |
| [검증과 테스트](docs/verification.md) | 로컬 검증, 통합 검증 현황 |
| [배포·라이선스·출처](docs/release-and-license.md) | 미게시 상태, 라이선스, 포함한 MIT 코드 |

## 관련 도구

- **ZWF:** [`zukuapp/zwf`](https://github.com/zukuapp/zwf)(MIT). 이 CLI는 0.1.0 구현을 고지와 함께 포함합니다.
- **API 안내:** <https://docs.zuzunza.com/>

`zukujs.json`, ZWF2 매니페스트, Next2D `jump-manifest.schema.json`, API `jump` 메타데이터는 서로 다른 형식입니다.

## 기여하기

명령을 바꿀 때는 실제 입출력과 실패 조건을 먼저 정하고 테스트를 추가해 주세요. 검증·업로드 실패를 성공으로 보고하면 안 되며, 변경 요청을 자동으로 재시도하지 마세요.

공개 문서의 시작점은 [ZUKU 개발자 허브](https://github.com/zukuapp/.github/blob/main/docs/README.md)입니다.
