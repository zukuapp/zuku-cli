<!-- BEGIN ZUKU OFFICIAL BRAND -->
<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <a href="https://docs.zuzunza.com/">
    <picture>
      <source media="(prefers-color-scheme: dark)"
        srcset="docs/branding/zuku-logo-dark.png">
      <img src="docs/branding/zuku-logo-light.png"
        alt="ZUKU" width="320">
    </picture>
  </a>
</p>
<p align="center">ZUKU - 내가 불러 일으키는 새로운 창작.</p>
<!-- markdownlint-enable MD033 MD041 -->
<!-- END ZUKU OFFICIAL BRAND -->

# @zukujs/cli: ZUKU 통합 게임 개발 환경

ZUKU/ZukuJS 게임을 만들고 검증하는 로컬 AI 에이전트와 명령줄 도구입니다. `zuku`와 기존 `zukujs`는 같은 진입점, Agent Core, 제공자 설정, 인증과 세션을 공유합니다. 소스 버전은 0.3.1입니다.

> **배포 상태:** 0.3.1은 npm 배포 후보입니다. 게시 확인 전에는 아래 소스 체크아웃 방법으로 실행하세요. 기존 0.3.0 네이티브 Studio 자산은 별도이며, 이 소스 버전이 새 GUI 릴리스를 뜻하지 않습니다.

## 설치 (소스 체크아웃)

Node.js 22 이상이 필요합니다.

```sh
git clone https://github.com/zukuapp/zukujs-cli.git
cd zukujs-cli
npm install
npm link
zuku --help
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

`create`·`validate`·`package`는 네트워크를 쓰지 않고 프로젝트 코드를 실행하지 않습니다. `upload`는 운영 서비스 `https://www.zuzunza.com/api/v1`에 실제로 업로드하고 초안을 만듭니다. 초안은 공개 목록에 나타나지 않지만 업로드된 `/uploads/...` 파일 URL은 공개 주소입니다.

`zuku agent "게임 설명"`은 게임 범위를 확인하고 필수 스킬, 빌드와 플레이테스트를 거칩니다. 공개 배포는 `agent --yolo` 또는 `deploy <path> --yolo`로 명시하며, 서버가 계정별 최근 6시간 성공 3회 한도를 적용합니다. 결과를 확인할 수 없는 게시 요청은 자동으로 다시 보내지 않습니다. 자세한 실행 조건과 복구 방법은 [게임 에이전트](docs/game-agent.md)에 있습니다.

설치된 Chromium을 지정하려면 `zuku agent "게임 설명" --browser /절대/경로/chrome`을 실행하세요. 네이티브 CLI가 실행 파일을 해당 프로젝트에 승인하고, 같은 Core가 재시작 후에도 승인된 파일을 확인하여 샌드박스 플레이테스트에 사용합니다. 기존 게임 유지보수는 실제 로드·렌더링·입력 검사를 수행합니다. 자세한 권한과 검증 범위는 [통합 CLI](docs/unified-cli.md)에 있습니다.

제공자와 모델은 `provider`, `model`, `auth`로 관리합니다. 비공식 Codex 인증은 명시적인 `--experimental`과 `(exp!)` 표시를 사용합니다. GTK/WebKit, AppKit/WKWebView, WPF/WebView2 Studio와 로컬 Browser Adapter는 같은 Core에 연결하며, 원격 클라우드 실행은 미정입니다. 플랫폼별 실제 검증 여부는 [검증 기록](docs/verification.md)을 확인하세요.

웹 프레임워크 패키지 `zukujs`가 설치된 프로젝트에서는 `zukujs dev`, `build`, `start` 등 프레임워크 명령으로 위임합니다. 자동 설치는 하지 않으며 [명령 참조](docs/commands.md#웹-프레임워크-명령)의 출력·설치 규칙을 따릅니다.

## 기존 upload 인증 요약

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
| [통합 CLI와 Agent Core](docs/unified-cli.md) | 별칭, 공유 상태, 명령 전달과 현재 호환 경계 |
| [게임 에이전트](docs/game-agent.md) | 게임 제작, 플레이테스트, YOLO 한도와 결과 불명 복구 |
| [제공자](docs/providers.md) / [모델](docs/models.md) / [인증](docs/provider-auth.md) | 제공자 어댑터, 모델 검색, 공식·실험 인증 |
| [게임 범위와 도구](docs/game-scope-and-tools.md) | 실행 시 적용하는 작업·경로·명령 경계 |
| [설치](docs/installation.md) / [Studio 배포](docs/studio-distribution.md) | SHA로 확인하는 설치와 플랫폼별 네이티브 자산 |

## 관련 도구

- **ZWF:** [`zukuapp/zwf`](https://github.com/zukuapp/zwf)(MIT). 이 CLI는 0.1.1 구현을 고지와 함께 포함합니다.
- **API 안내:** <https://docs.zuzunza.com/>

`zukujs.json`, ZWF2 매니페스트, Next2D `jump-manifest.schema.json`, API `jump` 메타데이터는 서로 다른 형식입니다.

## 기여하기

명령을 바꿀 때는 실제 입출력과 실패 조건을 먼저 정하고 테스트를 추가해 주세요. 검증·업로드 실패를 성공으로 보고하면 안 되며, 변경 요청을 자동으로 재시도하지 마세요.

공개 문서의 시작점은 [ZUKU 개발자 허브](https://github.com/zukuapp/.github/blob/main/docs/README.md)입니다.
