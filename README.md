# EnergyIQ — 우리 동네 에너지 효율 분석기

공공데이터포털 전력 사용량 + 한국에너지공단 가전 효율 등급 + Open-Meteo 날씨 데이터를  
**Grok AI**와 결합해 우리 집 에너지 소비 효율을 실시간으로 분석하는 플랫폼입니다.

---

## 주요 기능

- 지역별 한전 월간 가구 평균 전력사용량 조회 (최근 12개월)
- 한국에너지공단 가전제품 에너지소비효율 등급 실측 데이터 로드
- Open-Meteo 기반 현재 기온 연동
- Grok AI를 통한 가구별 맞춤형 에너지 절약 추천
- Chart.js 기반 월별 · 지역비교 · 기온상관 차트 시각화

---

## 기술 스택

| 구분 | 사용 기술 |
|------|-----------|
| Backend | Node.js, Express |
| HTTP 클라이언트 | axios |
| Frontend | Vanilla JS, Chart.js |
| AI | Grok API (xAI) |
| 공공데이터 | KEPCO 빅데이터 API, 한국에너지공단 API, Open-Meteo |

---

## 시작하기

### 1. 저장소 클론

```bash
git clone https://github.com/Grorar/energy-iq.git
cd energy-iq
```

### 2. 의존성 설치

```bash
npm install
```

### 3. 환경변수 설정

`.env.example` 파일을 복사해 `.env` 파일을 만들고, 각 항목에 API 키를 입력합니다.

```bash
cp .env.example .env
```

`.env` 파일을 열어 아래 항목을 채웁니다.

```
KEPCO_API_KEY=발급받은_한전_API_키
WEATHER_API_KEY=발급받은_날씨_API_키
GROK_API_KEY=발급받은_Grok_API_키
ENERGY_GRADE_KEY=발급받은_에너지공단_API_키
```

### 4. 서버 실행

```bash
npm start
```

브라우저에서 `http://localhost:3000` 으로 접속합니다.

---

## API 키 발급처

| API | 발급 URL |
|-----|----------|
| 한국전력공사 (KEPCO) | https://bigdata.kepco.co.kr |
| 한국에너지공단 효율등급 | https://www.data.go.kr (B553530) |
| Grok AI | https://console.x.ai |
| Open-Meteo | https://open-meteo.com (무료, 키 불필요) |

---

## 프로젝트 구조

```
energy-iq/
├── server.js        # Express 프록시 서버 (API 키 관리)
├── index.html       # 프론트엔드 (단일 페이지)
├── package.json
├── .env.example     # 환경변수 예시 (키 없음)
└── .gitignore
```

---

## 주의사항

- `.env` 파일에는 실제 API 키가 포함되어 있으므로 **절대 GitHub에 올리지 마세요.**
- `node_modules/` 폴더는 `.gitignore`에 포함되어 있으므로 `npm install`로 복원하세요.

---

© 2026 이유빈
