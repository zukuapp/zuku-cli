# {{NAME}}

ZukuJS로 만든 최소 HTML5 게임입니다. 빌드 단계나 외부 의존성 없이 `src/index.html`을 브라우저에서 열면 실행됩니다. 스페이스바·위쪽 화살표·탭으로 점프해 장애물을 피하세요.

| 경로 | 역할 |
| --- | --- |
| `src/index.html` | 진입점 (`zukujs.json`의 `entry`) |
| `src/game.js` | 게임 코드 (상대 경로로 불러옴) |
| `zukujs.json` | ZukuJS 로컬 프로젝트 매니페스트 (`zukujs-project/1`). 서비스 스키마가 아니며 패키지에 들어가지 않습니다. |

## 검사와 패키징

```sh
zukujs validate .
zukujs package .                    # dist/{{NAME}}-0.1.0.zwf (ZWF2)
zukujs package . --format zip       # dist/{{NAME}}-0.1.0.zip
```

패키지에는 `src/`만 들어갑니다. 결과는 공개 `@zuku/zwf` ZWF2(`html5-sandbox/2`) 또는 ZIP 계약을 따르며, 같은 입력이면 같은 바이트가 나오고 경로·크기·SHA-256을 출력합니다. 허용 확장자만 넣을 수 있고, 점(`.`)으로 시작하는 항목·`node_modules`·`package.exclude` 경로는 제외됩니다. 심볼릭 링크·하드 링크·대소문자만 다른 경로·실행 파일은 오류입니다. 패키징은 게임 코드를 실행하지 않습니다.

`zukujs.json`의 `title`·`description`·`tags`·`age_rating`·`jump`(게임 ID·장르·지원 플랫폼)는 업로드 시 JUMP 초안 메타데이터로 쓰입니다. 실제로 지원하는 플랫폼만 표시하세요. 업로드는 초안을 만들 뿐 게시하지 않습니다.
