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
| 통합 CLI 테스트(`npm test`) | 80/80 통과 | Node.js 26.3.0 |
| GitHub CI: 전체 테스트·문법·도움말 | 모두 통과 | Node.js 22 |
| 실제 백엔드 `upload`: ZIP·ZWF·프로젝트 디렉터리·WASM ZIP | 32개 검사 통과 | 격리된 실제 API |
| 실제 백엔드 기준 흐름(가입 → 업로드 → 초안) | 14개 검사 통과 | 격리된 실제 API |

- "격리된 실제 API"는 별도로 배포한 실제 백엔드 실행 파일과 일회용 데이터베이스, 그 환경에서 가입한 일반 사용자입니다. 모의 서버가 아니며 운영 서비스에 변경을 가하지 않았고, 운영 사용자 토큰을 쓰거나 전달하지 않았습니다.
- 확인 항목: 소유자 조회 성공, 게스트·익명 404/401, 초안 상태 유지, 공개 피드 비노출, 첫 공개·Thread 글 없음, 소유자 보관, 자격 증명 없는 `0600` 영수증.
- Node.js 22 [GitHub CI 실행 기록](https://github.com/zukuapp/zukujs-cli/actions/runs/37154764368)은 커밋 `b99b332`에서 전체 테스트·문법·도움말 검증을 통과했습니다.

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

macOS, Windows 실행은 별도 확인이 필요합니다.
