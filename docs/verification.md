# 검증과 테스트

## 로컬 검증

```sh
npm install
npm run lint
npm test
```

테스트는 로컬 fixture와 모의 서버만 사용하며 운영 API를 호출하지 않습니다. 계정이나 자격 증명 파일을 만들 필요가 없습니다.

## 검증 현황

| 범위 | 결과 | 환경 |
| --- | --- | --- |
| 루트 전체 CLI 회귀 스냅샷(2026-10-04, Windows 런타임 포함 수정 이후) | 총 559개: 546 통과, 플랫폼 전용 13 건너뜀, 실패 0 | Node.js 22.23.2 |
| Windows 소스 경계·프로토콜 및 여섯 네이티브 배포 계획/패키징 | 33/33 통과, 실패·건너뜀 0 | Node.js 22.23.2, 합성 패키징 fixture |
| macOS 정적 소스 검사 / JavaScript codec 검사 | 25개 / 9개 그룹 통과 | 텍스트 검사·격리 VM, Swift 컴파일 없음 |
| 문법 검사 | 155개 모듈 통과 | Node.js 22.23.2 |
| 실제 Linux GTK/WebKit Studio GUI·공유 Core·프로젝트 선택·미리보기 | 통과, 일반 사용자 UID 65534, 샌드박스 유지 | 실제 GTK/WebKit, 네이티브 프롬프트만 합성 입력 |
| 실제 WebKit 미리보기 HTTP 경계 | 허용 요청 2건, 경계 밖 이미지 요청 7개 모두 0건 | 일반 사용자 UID 65534, 합성 HTTP fixture |
| NAS의 provider/Core 부분 스냅샷 회귀 | 총 103개: 96 통과, 플랫폼 전용 7 건너뜀, 실패 0 | NAS 일반 사용자, Node.js 22.22.3 |
| GitHub CI 0.3.0 및 실제 Windows/macOS GUI | 이번 소스에서는 확인하지 않음 | 네이티브 6개 작업 설정, 실제 CI 성공은 별도 |
| 실제 백엔드 `upload`: ZIP·ZWF·프로젝트 디렉터리·WASM ZIP | 32개 검사 통과 | 격리된 실제 API |
| 실제 백엔드 기준 흐름(가입 → 업로드 → 초안) | 14개 검사 통과 | 격리된 실제 API |

- "격리된 실제 API"는 별도로 배포한 실제 백엔드 실행 파일과 일회용 데이터베이스, 그 환경에서 가입한 일반 사용자입니다. 모의 서버가 아니며 운영 서비스에 변경을 가하지 않았고, 운영 사용자 토큰을 쓰거나 전달하지 않았습니다.
- 확인 항목: 소유자 조회 성공, 게스트·익명 404/401, 초안 상태 유지, 공개 피드 비노출, 첫 공개·Thread 글 없음, 소유자 보관, 자격 증명 없는 `0600` 영수증.
- 전체 회귀 로그 `root-cli-all-post-windows-20261004.tap`의 SHA-256은 `ccc3e61af84fdca2ee43a64fc8bda15920b3b66d869a1d31649981aa1266dada`입니다. 13개 플랫폼 건너뜀을 통과로 계산하지 않았습니다. 이후 네이티브 빌드 계획 수정은 관련 33개 검사로 별도 확인했습니다.
- 실제 Linux GUI 증적 `gui-frozen.json` SHA-256은 `55d71a736f04eed6680edd4bd4af3eae6577b1699432163b00a64d84dbd02d18`, HTTP 경계 증적 `preview-http-proof.json`은 `f1093cbe585e5c108901201775271214c6adafec390615c833a1e11e2e751393`입니다. 원본 소스·검증 증적은 NAS의 `studio-linux-native-final-20261004/linux-native-proof.tgz`에 보존했습니다. 실제 화면·Core 검증은 OAuth 로그인, 유료 추론, 게임 게시 성공을 뜻하지 않습니다.
- NAS 부분 회귀의 `SOURCE.json` SHA-256은 `a6f81289cb24a51806e0645b336d8d41565611b9fcb90bc886887dbf4dd3c4aa`이며 입력 파일 4,102개를 확인했습니다. `RESULT.json` SHA-256은 `67d605450e3b0df06b0944b9fffe499e82cb7d9f1a4310525cb83fb95a18a423`입니다. 이 별도 스냅샷을 현재 전체 회귀나 실제 Windows 검증으로 계산하지 않았습니다.
- Node.js 22 [GitHub CI 실행 기록](https://github.com/zukuapp/zukujs-cli/actions/runs/37154764368)은 과거 커밋 `b99b332`의 기록입니다. 현재 0.3.0 소스나 Windows 런타임 포함 배포의 CI 성공 증거로 사용하지 않습니다.

## 네트워크 없이 확인하기

```sh
tmp=$(mktemp -d) && cd "$tmp"
zukujs create catch-game && cd catch-game
zukujs validate .
zukujs package . --format zwf
sha256sum dist/*.zwf
zukujs package . --format zwf --force    # 같은 입력이면 같은 바이트
sha256sum dist/*.zwf
zukujs validate dist/*.zwf
```

두 SHA-256 값이 같아야 합니다.

## 운영 서비스 주의

`upload`를 운영 서비스에 실행하면 실제 초안과 공개 `/uploads/...` 파일이 생깁니다. 자동 테스트에 넣지 마세요.

## 확인되지 않은 환경

macOS, Windows 실제 실행은 별도 확인이 필요합니다. Windows 공식 자산은 .NET 10을 포함하도록 구성됐으며, WebView2 Evergreen은 별도 런타임입니다. .NET 없는 새 Windows PC에서 실제 게시 자산 실행과 WebView2 유무별 동작은 아직 확인하지 않았습니다. 자세한 조건은 [Windows Studio 문서](studio-windows.md)를 참고하세요.
