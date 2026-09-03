---
title: 스토어 스크린샷
---

App Store Connect 에 올리는 스크린샷을 만든다. `./render.sh` 가 `*.html` 을 규격 크기 PNG 로 렌더한다.

| | |
|---|---|
| 캔버스 크기 | 파일명 접두사로 정해진다 — `mac-*` 2880×1800, `iphone-*` 1320×2868, `ipad-*` 2064×2752 |
| 입력 | `captures/` — 실행 중인 앱을 찍은 캡처. **커밋하지 않는다** |
| 출력 | `out/` 또는 `$QUICKGLOT_SHOTS_OUT`. **커밋하지 않는다** |
| 요구 도구 | Chrome(`$CHROME` 로 경로 재지정 가능) · ImageMagick |

알파 채널이 있는 스크린샷은 App Store Connect 가 거부하므로 렌더 결과는 흰 배경에 합성해 알파를 벗긴다.

## 필요한 캡처

| 템플릿 | 캡처 파일 | 무엇을 찍나 |
|---|---|---|
| `mac-1` | `captures/cap-hero.png` | Safari 에서 한 문장을 골라 번역이 뜬 화면 |
| `mac-2` | `captures/cap-before.png` | 문단 전체를 골라 번역이 뜬 화면 |
| `mac-3` | `captures/cap-app-win.png` | 앱 본체 창 |
| `iphone-1` | `captures/cap-iphone-hero.png` | iPhone Safari 에서 한 문장을 골라 번역이 뜬 화면 |
| `iphone-2` | `captures/cap-iphone-select.png` | iPhone Safari 에서 문단 전체를 골라 번역이 뜬 화면 |
| `iphone-3` | `captures/cap-iphone-app.png` | iPhone 앱 본체 화면 |

iPhone 캡처는 기기에서 그대로 찍은 전체 화면(1320×2868)을 넣으면 된다 — 템플릿이 폭 1060px 로 줄여 카드 안에 앉힌다. 크롭하지 않아도 캔버스 안에 들어간다.

## 캡처 규칙

- **프레임 안은 진짜 화면이어야 한다.** 배경·헤드라인·기기 목업은 자유지만 앱 UI 를 합성하거나 없는 기능을 그리면 심사 거부 사유다(가이드라인 2.3.3).
- **Retina 화면에서 찍는다.** 1x 모니터에서 찍으면 72dpi 로 저장돼 확대 시 뭉갠다. `sips -g dpiWidth <파일>` 이 144 여야 한다.
- **크롭 경계를 글자가 아니라 여백에 둔다.** 단어가 잘리면 깨진 화면으로 보인다.
- **번역 결과를 한 번 읽어본다.** 관용구·부정문은 오역이 잦다 — 평서문을 고르면 안전하다.
- **시뮬레이터에는 온디바이스 번역 모델이 없다**(iOS 26.3·26.5 실측). 번역이 보이는 화면은 실기기나 macOS 에서만 찍힌다.
