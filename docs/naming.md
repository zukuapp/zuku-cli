# 이름 규칙과 마이그레이션

## 표기

| 대상 | 이름 |
| --- | --- |
| 제품 표시 이름 | **ZukuJS** |
| 명령줄 도구 패키지 | **`@zukujs/cli`** (0.2.0) |
| 명령 | **`zukujs`** |
| 프레임워크 패키지·범위 | `zukujs`, `@zukujs/*` (프레임워크 이름 변경은 프레임워크 저장소에서 진행 중) |
| 브라우저 자산 접두사(프레임워크) | `/_zukujs` (프레임워크 이름 변경과 함께 적용 예정) |

"ZUKU"는 조직·서비스 이름(예: ZUKU 개발자 허브)에만 씁니다. 서비스 도메인(`www.zuzunza.com`, `docs.zuzunza.com`), API 경로·ID, ZWF 이름(`ZWF2`, `.zwf`, `application/zwf`), 명령 프로토콜 `zuku-command/1`은 실제 계약이므로 바꾸지 않습니다.

## `zukujs` 명령과 프레임워크

현재 `zukujs` 명령은 `@zukujs/cli`가 제공하며, 프레임워크 명령은 아직 `next`입니다. 프레임워크 명령의 이름 변경은 해당 저장소에서 진행 중입니다. 두 패키지가 제공하는 명령은 목적과 설치 위치가 다르므로, 프로젝트별 의존성이나 명시적인 패키지 실행 경로를 사용하세요.

## 이전 이름에서 옮기기

| 이전 | 현재 | 호환 |
| --- | --- | --- |
| 패키지 `zuku-cli` 0.1.0 | `@zukujs/cli` 0.2.0 | — |
| 명령 `zuku` | `zukujs` | 스크립트의 명령 이름을 바꾸세요 |
| `ZUKU_ACCESS_TOKEN` | `ZUKUJS_ACCESS_TOKEN` | 이전 이름을 명시적 별칭으로 계속 읽음(새 이름 우선) |
| `ZUKU_CREDENTIALS_FILE` | `ZUKUJS_CREDENTIALS_FILE` | 이전 이름을 명시적 별칭으로 계속 읽음(새 이름 우선) |
| `~/.config/zuku/credentials.json` | `~/.config/zukujs/credentials.json` | 이전 기본 경로는 자동으로 읽지 않음 |
| `create`·`validate`·`package`·`upload` 시제품(`NOT_IMPLEMENTED`) | 구현됨 | — |

이전 기본 파일을 쓰던 경우:

```sh
mkdir -p ~/.config/zukujs
mv ~/.config/zuku/credentials.json ~/.config/zukujs/credentials.json
chmod 600 ~/.config/zukujs/credentials.json
```

## 런타임 메타데이터

`version` 명령은 ZukuJS 런타임 정체성(이름 `ZukuJS`, 버전 `27.0.0`, 업스트림 `16.4.0-canary.58`, 명령 프로토콜 `zuku-command/1`)과 CLI 버전을 따로 보고합니다. 이 정체성은 ZukuJS 저장소의 `zukujs-version.json`과 같은 내용입니다.
