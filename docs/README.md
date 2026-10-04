# @zukujs/cli 문서

ZUKU 통합 게임 개발 도구 `@zukujs/cli`(소스 버전 0.3.0)의 문서입니다. `zuku`와 기존 `zukujs`는 같은 CLI와 Agent Core를 실행합니다. 이 저장소 `zukuapp/zukujs-cli`가 소스입니다.

| 문서 | 내용 |
| --- | --- |
| [시작하기](getting-started.md) | 요구 사항, 소스 체크아웃에서 설치·실행 |
| [명령 참조](commands.md) | 명령·플래그, `zuku-command/1` 응답, 종료 코드 |
| [인증과 서비스 엔드포인트](authentication.md) | 토큰 기밀성, 자격 증명 순서·파일 규칙, 호출하는 API |
| [프로젝트 작업 흐름](project-workflow.md) | `create` → `validate` → `package` → `upload`(초안), `zukujs.json` 스키마, ZWF2, 영수증 |
| [이름 규칙과 마이그레이션](naming.md) | ZukuJS 표기, 이전 이름(`zuku-cli`, `zuku`, `ZUKU_*`)에서 옮기기 |
| [검증과 테스트](verification.md) | 로컬 검증 명령, 통합 검증 현황 |
| [배포·라이선스·출처](release-and-license.md) | npm 미게시, 라이선스 표기, 포함한 MIT 코드 |
| [통합 CLI와 Agent Core](unified-cli.md) | 공유 상태, 명령 전달과 현재 호환 경계 |
| [게임 에이전트](game-agent.md) / [게임 범위](game-scope-and-tools.md) | 제작·검증·배포와 실행 시 작업 제한 |
| [제공자](providers.md) / [모델](models.md) / [인증](provider-auth.md) | 동적 모델 검색과 공식·실험 인증 |
| [설치](installation.md) / [Studio 배포](studio-distribution.md) | SHA를 확인하는 설치와 네이티브 플랫폼 자산 |

## 상태 요약

- 기존 `create`, `validate`, `package`, `upload`와 프레임워크 명령을 유지하며, `agent`, `init`, `chat`, `test`, `run`, `studio`, `doctor`, `provider`, `model`, `auth`, `login`, `account`, `deploy`를 제공합니다.
- `upload`는 **초안**을 만듭니다. `agent --yolo`와 `deploy --yolo`는 계정별 서버 한도에 따라 실제 공개 배포를 요청합니다.
- npm 레지스트리에 게시되지 않았습니다. 소스 체크아웃에서 실행합니다.

ZukuJS 프레임워크 문서는 [`zukuapp/zukujs`](https://github.com/zukuapp/zukujs)의 `ZUKUJS.md`와 `docs/00-zukujs/`에 있습니다.
