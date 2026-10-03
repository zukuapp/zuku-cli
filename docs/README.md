# @zukujs/cli 문서

ZukuJS 명령줄 도구 `@zukujs/cli`(명령 `zukujs`, 버전 0.2.0)의 문서입니다. 이 저장소 `zukuapp/zukujs-cli`가 소스입니다.

| 문서 | 내용 |
| --- | --- |
| [시작하기](getting-started.md) | 요구 사항, 소스 체크아웃에서 설치·실행 |
| [명령 참조](commands.md) | 명령·플래그, `zuku-command/1` 응답, 종료 코드 |
| [인증과 서비스 엔드포인트](authentication.md) | 토큰 기밀성, 자격 증명 순서·파일 규칙, 호출하는 API |
| [프로젝트 작업 흐름](project-workflow.md) | `create` → `validate` → `package` → `upload`(초안), `zukujs.json` 스키마, ZWF2, 영수증 |
| [이름 규칙과 마이그레이션](naming.md) | ZukuJS 표기, 이전 이름(`zuku-cli`, `zuku`, `ZUKU_*`)에서 옮기기 |
| [검증과 테스트](verification.md) | 로컬 검증 명령, 통합 검증 현황 |
| [배포·라이선스·출처](release-and-license.md) | npm 미게시, 라이선스 표기, 포함한 MIT 코드 |

## 상태 요약

- 구현됨: `help`, `version`, `status`/`diagnostics`(`--check-api`), `create`, `validate`, `package`, `upload`.
- `upload`는 패키지 업로드 후 **초안** JUMP 콘텐츠만 만듭니다. 공개(publish)는 하지 않습니다.
- npm 레지스트리에 게시되지 않았습니다. 소스 체크아웃에서 실행합니다.

ZukuJS 프레임워크 문서는 [`zukuapp/zukujs`](https://github.com/zukuapp/zukujs)의 `ZUKUJS.md`와 `docs/00-zukujs/`에 있습니다.
