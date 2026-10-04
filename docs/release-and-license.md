# 배포·라이선스·출처

## 배포 상태

- `@zukujs/cli` 0.3.1은 npm 배포 후보입니다. 게시 확인 전에는 [시작하기](getting-started.md)의 소스 체크아웃 방법으로 실행하세요.
- npm 소스 패키지와 네이티브 Studio 배포는 별도입니다. 기존 0.3.0 GUI 자산과 검증 기록은 유지하며 새 0.3.1 GUI 릴리스를 주장하지 않습니다.

## 라이선스 표기

- `package.json`의 `license` 값은 기존 그대로 `"SOL"`입니다. SPDX 식별자가 아니며 저장소에 LICENSE 파일이 없습니다. 이 문서는 라이선스를 새로 부여하지 않습니다.

## 포함한 제3자 코드

| 구성 요소 | 출처 | 라이선스 |
| --- | --- | --- |
| ZWF2 구현 | [`zukuapp/zwf`](https://github.com/zukuapp/zwf) 0.1.1, 저장소에 포함(vendored); 고정 소스·해시는 `lib/vendor/zwf/PROVENANCE.json` | MIT. 고지를 함께 배포해야 함 |
| `fflate` 0.8.3 | npm 의존성 | 해당 패키지의 라이선스를 따름 |

## 관련 저장소

| 구성 요소 | 출처 | 라이선스 |
| --- | --- | --- |
| ZukuJS 프레임워크 | `zukuapp/zukujs`, Next.js v16.4.0-canary.58 파생 | MIT, "Copyright (c) 2025 Vercel, Inc." 고지 유지 |

업스트림 저작권·라이선스 고지는 삭제하거나 바꾸지 않습니다.
