# Context Tracker
대화를 보낼 때 AI에게 전달되는 입력이 얼마나 쌓였는지 확인하는 SillyTavern 확장입니다. 입력량을 원형 게이지로 보여 주고, 옵션에서 `컨텍스트 크기 대비 사용량`, `챗 히스토리 대비 사용량`을 전환할 수 있습니다.

## 미리보기

### 표시 방식
| 입력 예산 표시 | 챗 히스토리 표시 |
|:---:|:---:|
| <img src="https://raw.githubusercontent.com/st-chd/chd-asset/main/Asset-ContextTracker/Budget.png" width="300"> | <img src="https://raw.githubusercontent.com/st-chd/chd-asset/main/Asset-ContextTracker/History.png" width="300"> |

### 배치 영역
| 입력 영역 좌측 | 입력 영역 우측 |
|:---:|:---:|
| <img src="https://raw.githubusercontent.com/st-chd/chd-asset/main/Asset-ContextTracker/leftSendForm.png" width="300"> | <img src="https://raw.githubusercontent.com/st-chd/chd-asset/main/Asset-ContextTracker/rightSendForm.png" width="300"> |
| **좌측 상단** | **우측 상단** |
| <img src="https://raw.githubusercontent.com/st-chd/chd-asset/main/Asset-ContextTracker/sendformLeft.png" width="300"> | <img src="https://raw.githubusercontent.com/st-chd/chd-asset/main/Asset-ContextTracker/sendformRight.png" width="300"> |

## 설치

SillyTavern **확장(Extensions)** 메뉴에 아래 주소를 붙여 넣어 설치하세요.
```
https://github.com/st-chd/ContextTracker
```

## 크레딧 및 라이선스

이 확장은 [Wanichka의 Context Tracker](https://github.com/Wanichka/sillytavern-context-tracker)를 포크하여 수정했으며, 모든 수정에는 GPT(codex)를 사용했습니다.\
원본 확장의 MIT 라이선스를 따르며, 자세한 내용은 [LICENSE](LICENSE) 파일을 확인해 주세요.

**호환성을 위해 참고한 확장 프로그램**\
`#form_sheld` 안에 위치해야하는 특성상 호환을 위해 아래 확장 프로그램의 코드를 확인했으며, 해당 프로젝트의 코드를 복사하지 않았습니다.
- [Samueras의 GuidedGenerations-Extension](https://github.com/Samueras/GuidedGenerations-Extension/) (GPL-3.0)
- [IceFog72의 SillyTavern-SimpleQRBarToggle](https://github.com/IceFog72/SillyTavern-SimpleQRBarToggle) (MIT)

## 주요 기능 및 변경 사항

- 입력창에 컨텍스트 사용량을 원형 게이지로 표시합니다.
- 게이지를 누르면 총 토큰, 컨텍스트 크기, 최대 응답 길이, 입력 예산, 잔여량을 보여 줍니다.
- 메시지 수정 등으로 입력이 바뀌면 SillyTavern 본체가 다시 집계한 값을 표시합니다. 토큰 수는 SillyTavern 본체의 집계와 토큰 카운터를 사용합니다.
- 확장 설정에서 게이지를 입력창 왼쪽이나 오른쪽, 전송 버튼 왼쪽이나 오른쪽에 배치할 수 있습니다.
- **챗 히스토리 예산으로 계산**을 켜면 대화 기록만 설정한 상한선과 비교합니다. 기본 상한선은 50,000 토큰입니다.
- **사용량 상세보기**를 켜면 프롬프트, 월드 인포, 캐릭터 시트, 챗 히스토리의 토큰 수를 추가로 보여 줍니다. 캐릭터 시트에는 페르소나 설명과 고급정의도 포함됩니다.

## 참고 사항

### 1. 사용 환경

이 확장은 Chat Completion 방식에서 동작합니다. 다른 API를 사용 중이거나 SillyTavern 업데이트로 필요한 기능이 바뀌면 집계가 표시되지 않을 수 있습니다. 현재 SillyTavern 1.19.0 기준으로 작동합니다.

### 2. 패널 구성
- **컨텍스트 크기:** AI응답 구성 패널의 `컨텍스트 크기 (토큰)` 설정량을 표시합니다.
- **최대 응답 길이:** AI응답 구성 패널의 `최대 응답 길이 (토큰)` 설정량을 표시합니다.
- **입력 예산:** `컨텍스트 크기 - 최대 응답 길이 = 입력 예산` 공식을 사용하여 표시합니다.
- **잔여량:** 입력 예산에서 사용량을 뺀 잔여량을 표시합니다.

확장 프로그램이 임의로 사용량을 정하지 않습니다.
확장 프로그램은 본체가 집계한 토큰 수와 본체의 토큰 카운터를 사용하며, 별도의 AI 생성 요청을 보내지 않습니다. 따라서 확장 프로그램으로 인한 추가 비용은 발생하지 않습니다.

### 3. 표시된 토큰 수와 청구량

이 확장은 SillyTavern이 계산한 입력 토큰 수를 표시합니다. 서비스에 실제로 전송되거나 청구되는 수와는 다를 수 있습니다.

### 4. 챗 히스토리 예산 모드

확장 설정에서 **챗 히스토리 예산으로 계산**을 켜고 상한선을 입력하면, 대화 기록만 상한선과 비교합니다. 입력 예산, 히스토리 예산, 잔여량만 표시합니다.

> 예) 챗 히스토리 상한선 80,000 · 현재 챗 히스토리 60,000 토큰 → **75% 사용**, 잔여량 20,000

**패널 표시**
- **챗 히스토리 (n개):** 숨기지 않은 메시지 수입니다. `/hide`로 숨긴 메시지와 시스템 메시지는 제외합니다. 표시할 메시지가 없으면 `(n개)`는 생략합니다.
- 메시지 수에는 토큰 예산 때문에 입력에서 빠진 오래된 메시지도 포함될 수 있습니다.
- 히스토리 예산은 입력 예산을 넘지 않습니다. 더 큰 값을 입력하면 입력 예산으로 맞춰 저장합니다. 나중에 입력 예산이 줄면 줄어든 만큼만 적용하고, 다시 늘면 저장한 값까지 돌아갑니다.
- 상한선을 넘으면 게이지가 가득 차고 잔여량은 0이 되지만, **확장이 대화를 자르지는 않습니다.**

### 5. 그룹 채팅

마지막으로 집계된 발화 캐릭터의 입력을 보여 줍니다. 그룹의 모든 캐릭터 입력을 더한 값은 아닙니다.

### 6. 사용량 상세보기

이번 입력의 토큰을 네 항목으로 나눠 보여 줍니다. 일반 모드에서는 네 항목의 합이 총 토큰과 같습니다.

- **프롬프트:** 메인, 보조, 후처리 지시문 등 나머지 프롬프트
- **월드 인포:** before·after 위치의 월드 인포
- **캐릭터 시트:** 캐릭터 설명, 페르소나 설명, 고급 정의(성격, 시나리오, 대화 예시)
- **챗 히스토리:** 본체가 집계한 챗 히스토리

프롬프트에 시트 매크로(`{{description}}`, `{{persona}}` 등)를 넣은 경우:

- 한 종류의 매크로만 있으면(예: `{{persona}}` 단독) 프롬프트 전체를 캐릭터 시트로 집계합니다.
- 문구나 다른 매크로와 함께 있으면 매크로 값만 캐릭터 시트로, 나머지는 프롬프트로 집계합니다. 값의 토큰은 설명란 토큰 카운터와 같습니다.

챗 히스토리 예산 모드에서는 챗 히스토리 행을 생략합니다. 상세보기는 기본적으로 꺼져 있습니다.
