require('dotenv').config();

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── API 키 (.env에서 로드) ── */
const KEPCO_API_KEY    = process.env.KEPCO_API_KEY;
const WEATHER_API_KEY  = process.env.WEATHER_API_KEY;
const GROK_API_KEY     = process.env.GROK_API_KEY;
const ENERGY_GRADE_KEY = process.env.ENERGY_GRADE_KEY;

// 필수 키 누락 시 경고
const requiredKeys = { KEPCO_API_KEY, WEATHER_API_KEY, GROK_API_KEY, ENERGY_GRADE_KEY };
Object.entries(requiredKeys).forEach(([name, val]) => {
  if (!val) console.warn(`⚠️  환경변수 ${name} 가 설정되지 않았습니다. .env 파일을 확인하세요.`);
});

/* ── 한국 시간 헬퍼 ── */
function getKSTDate(offsetHours = 0) {
  const now = new Date();
  return new Date(now.getTime() + (9 * 60 + offsetHours * 60) * 60 * 1000);
}
const pad = n => String(n).padStart(2, '0');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

/* ══════════════════════════════════════════
   ① 한전 가구평균 전력사용량 API
   bigdata.kepco.co.kr — year/month/metroCd
══════════════════════════════════════════ */
app.get('/api/kepco', async (req, res) => {
  const { metroCd } = req.query;
  try {
    const kst = getKSTDate();
    const results = [];

    // 최근 12개월 — 2개월 전부터 시작 (당월/전월은 데이터 미확정 가능)
    for (let i = 2; i <= 13; i++) {
      const d     = new Date(kst.getFullYear(), kst.getMonth() - i, 1);
      const year  = d.getFullYear();
      const month = pad(d.getMonth() + 1);
      const url   = `https://bigdata.kepco.co.kr/openapi/v1/powerUsage/houseAve.do`
        + `?year=${year}&month=${month}&metroCd=${metroCd}&apiKey=${KEPCO_API_KEY}&returnType=json`;
      try {
        const r    = await axios.get(url, { timeout: 5000 });
        const data = r.data?.data;
        if (data && data.length > 0) {
          const avg = data.reduce((s, it) => s + parseFloat(it.powerUsage || 0), 0) / data.length;
          results.push({ year, month, powerUsage: avg.toFixed(2) });
        }
      } catch(e) { /* 해당 월 없으면 스킵 */ }
    }

    results.reverse(); // 오래된 순 정렬
    console.log(`[한전] metroCd=${metroCd} 수집 ${results.length}개월`);
    res.json({ data: results });
  } catch (err) {
    console.error('[한전 API 오류]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════
   ② 기상청 대체 — Open-Meteo API
   무료, 인증키 불필요, 위도/경도 기반
   ※ 무료 API rate limit(429) 대응을 위해 서버 캐싱 적용
══════════════════════════════════════════ */
const weatherCache = {}; // { "lat,lon": { temp, timestamp } }
const WEATHER_CACHE_TTL = 15 * 60 * 1000; // 15분

app.get('/api/weather', async (req, res) => {
  const { lat, lon } = req.query;
  const cacheKey = `${lat},${lon}`;
  const cached   = weatherCache[cacheKey];

  // 캐시가 유효하면 바로 반환 (불필요한 외부 호출 줄여 429 방지)
  if (cached && Date.now() - cached.timestamp < WEATHER_CACHE_TTL) {
    console.log(`[기상(캐시)] lat=${lat} lon=${lon} 기온=${cached.temp}°C`);
    return res.json({ temp: cached.temp, cached: true });
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast`
      + `?latitude=${lat}&longitude=${lon}`
      + `&current=temperature_2m`
      + `&timezone=Asia%2FSeoul`;

    const response = await axios.get(url, { timeout: 10000 });
    const temp = response.data?.current?.temperature_2m;

    if (temp !== undefined && temp !== null) {
      weatherCache[cacheKey] = { temp, timestamp: Date.now() };
    }

    console.log(`[기상(Open-Meteo)] lat=${lat} lon=${lon} 기온=${temp}°C`);
    res.json({ temp });
  } catch (err) {
    console.error('[기상 API 오류]', err.message);

    // 외부 API 실패(429 등) 시, 만료되었더라도 캐시된 값이 있으면 반환
    if (cached) {
      console.warn(`[기상] 실패 → stale 캐시 사용 (lat=${lat}, lon=${lon}, 기온=${cached.temp}°C)`);
      return res.json({ temp: cached.temp, stale: true });
    }

    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════
   ③ 한국에너지공단 에너지소비효율 등급 API
   로그에서 확인된 실제 경로 및 필드명 기반
   ac:          EEP_03 → INPUT_PWR (형광램프 포함되어 있으나 에어컨도 있음)
   fridge:      EEP_04 → DISPLAY:"LED", R 필드 (TV가 EEP_04인 것으로 확인)
                         냉장고 경로 미확인 → 제외
   dryer:       EEP_05 → MEAS_CONS_PWR (전진공청소기 포함)
   tv:          EEP_04 → R 필드 (SAMPLE_EFFIC 등)
   dishwasher:  EEP_08 → CONS_PWR (W/m² 단위, 별도 처리)
   ricecooker:  EEP_07 → 선풍기(팬) 데이터 → 전기밥솥 아님, 제외
══════════════════════════════════════════ */

// 로그에서 확인된 기자재별 실제 필드명 매핑
const EEP_CONFIG = {
  ac: {
    path: 'EEP_03_LIST',
    name: '에어컨',
    // ac 로그: INPUT_PWR:"39.9(W)", EFFIC:"82.21(lm/W)", MACH_TERM:"형광램프"
    // → EEP_03이 형광램프(조명) API임. 에어컨 경로 미확인 → 제외
    skip: true,
  },
  fridge: {
    path: 'EEP_04_LIST',
    name: '냉장고',
    // fridge 로그(EEP_17): MACH_TERM:"텔레비전수상기", DISPLAY:"LED", R:"102.9(W)"
    // → EEP_17이 TV. 냉장고 경로 미확인 → 제외
    skip: true,
  },
  dryer: {
    path: 'EEP_05_LIST',
    name: '건조기',
    // 로그: MACH_TERM:"전진공청소기", MEAS_CONS_PWR:"1,478.4(W)", MAX_CAPA:"438.3(W)"
    // → EEP_05가 진공청소기. 건조기 경로 미확인 → 제외
    skip: true,
  },
  washer: {
    path: 'EEP_01_LIST',
    name: '세탁기',
    // 로그: totalCount:0 → 데이터 없음
    skip: true,
  },
  tv: {
    path: 'EEP_04_LIST',
    name: 'TV',
    // 로그: MACH_TERM:"텔레비전수상기", R:"102.9(W)", DISPLAY:"LED", CAPA:"26(W)"
    pwrField: 'R',        // R = 소비효율등급지표(W)
    altField: 'CAPA',     // CAPA = 화면크기 아닌 소비전력일 수 있음
    unit: 'W',
    pwrUnit: 'W(정격)',
    // 월간환산: W × 하루 5h × 30일 / 1000
    toMonthly: (w) => Math.round(w * 5 * 30 / 1000),
  },
  dishwasher: {
    path: 'EEP_08_LIST',
    name: '식기세척기',
    // 로그: CONS_PWR:"1.13(W/m²)", STANDARD_CONS_AREA:"19.3(m²)", WAIT_PWR:"0(W)"
    // CONS_PWR이 W/m²이므로 STANDARD_CONS_AREA와 곱해서 실제 W 계산
    pwrField: 'CONS_PWR',
    areaField: 'STANDARD_CONS_AREA',
    unit: 'W/m²',
    pwrUnit: 'W(소비전력)',
    toMonthly: (w) => Math.round(w * 16 / 1000),  // 16회/월 × Wh
  },
  purifier: {
    path: 'EEP_06_LIST',
    name: '공기청정기',
    // 로그: totalCount:0 → 데이터 없음
    skip: true,
  },
  ricecooker: {
    path: 'EEP_07_LIST',
    name: '전기밥솥(팬)',
    // 로그: MACH_TERM:"선풍기", FAN_DIAMETER:"35(cm)", CONS_EFFIC:"1.22(m³/min)/W)"
    // → EEP_07이 선풍기/환풍기. 전기밥솥 경로 미확인 → 제외
    skip: true,
  },
};

// 실제 동작하는 기자재만 추출
const EEP_PATHS = Object.fromEntries(
  Object.entries(EEP_CONFIG).filter(([,v]) => !v.skip).map(([k,v]) => [k, v.path])
);

app.get('/api/energy-grade', async (req, res) => {
  const { appliance } = req.query;
  const cfg = EEP_CONFIG[appliance];

  // skip 처리 또는 미지원 기자재
  if (!cfg) return res.status(400).json({ error: '지원하지 않는 기자재입니다.' });
  if (cfg.skip) {
    return res.json({
      appliance,
      stats: null,
      samples: [],
      skipped: true,
      reason: '해당 기자재의 공공데이터 경로가 확인되지 않음',
    });
  }

  try {
    const url = `http://apis.data.go.kr/B553530/eep/${cfg.path}`
      + `?serviceKey=${ENERGY_GRADE_KEY}&pageNo=1&numOfRows=100&apiType=json`;

    const r    = await axios.get(url, { timeout: 30000, headers: { 'Accept': 'application/json' } });
    const body = r.data;

    // 공공데이터포털 응답 파싱
    let items = [];
    if (body?.data && Array.isArray(body.data)) {
      items = body.data;
    } else if (body?.response?.body?.items?.item) {
      const raw = body.response.body.items.item;
      items = Array.isArray(raw) ? raw : [raw];
    } else if (body?.items?.item) {
      const raw = body.items.item;
      items = Array.isArray(raw) ? raw : [raw];
    }

    if (items.length > 0) {
      console.log(`[에너지등급] ${appliance} 첫번째 아이템:`, JSON.stringify(items[0]));
    }

    if (!items || items.length === 0) {
      return res.json({ appliance, stats: null, samples: [], raw: body });
    }

    // 기자재별 소비전력 추출 (확인된 필드명 기반)
    const pwrExtract = (item) => {
      if (appliance === 'tv') {
        // R 필드: "102.9(W)" → 숫자 추출
        const r = parseFloat(String(item.R || '').replace(/[^0-9.]/g, ''));
        if (!isNaN(r) && r > 0) return r;
        const c = parseFloat(String(item.CAPA || '').replace(/[^0-9.]/g, ''));
        if (!isNaN(c) && c > 0) return c;
      }
      if (appliance === 'dishwasher') {
        // CONS_PWR(W/m²) × STANDARD_CONS_AREA(m²) = 실제 W
        const cpRaw   = parseFloat(String(item.CONS_PWR || '').replace(/[^0-9.]/g, ''));
        const areaRaw = parseFloat(String(item.STANDARD_CONS_AREA || '').replace(/[^0-9.]/g, ''));
        if (!isNaN(cpRaw) && !isNaN(areaRaw) && areaRaw > 0) return Math.round(cpRaw * areaRaw);
        // fallback: WAIT_PWR
        const wp = parseFloat(String(item.WAIT_PWR || '').replace(/[^0-9.]/g, ''));
        if (!isNaN(wp) && wp > 0) return wp;
      }
      return null;
    };

    const grade1Items = items.filter(it => String(it.GRADE) === '1');
    const allPwrs = items.map(pwrExtract).filter(v => v !== null && v > 0);
    const g1Pwrs  = grade1Items.map(pwrExtract).filter(v => v !== null && v > 0);

    const avg = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null;
    const min = arr => arr.length ? Math.min(...arr) : null;
    const max = arr => arr.length ? Math.max(...arr) : null;

    const gradeDist = {};
    items.forEach(it => {
      const g = String(it.GRADE ?? '기타');
      gradeDist[g] = (gradeDist[g] || 0) + 1;
    });

    const avgPwr = avg(allPwrs);
    const toMonthly = cfg.toMonthly || ((w) => Math.round(w * 5 * 30 / 1000));

    const stats = {
      totalCount:  items.length,
      avgPwr,
      minPwr:      min(allPwrs),
      maxPwr:      max(allPwrs),
      grade1Avg:   avg(g1Pwrs),
      grade1Count: grade1Items.length,
      gradeDist,
      pwrUnit:     cfg.pwrUnit || 'W',
      monthlyKwh:  avgPwr ? toMonthly(avgPwr) : null,
    };

    const samples = items.slice(0, 10).map(it => ({
      model:    it.MODEL_TERM,
      brand:    it.ENTE_TERM || it.MANUFAC_MAN_TERM,
      grade:    it.GRADE,
      pwr:      pwrExtract(it),
      shipDate: it.SHIP_PRARG_DD,
    }));

    console.log(`[에너지등급] ${appliance} 조회완료 — 총 ${items.length}건, avgPwr=${avgPwr}`);
    res.json({ appliance, stats, samples });

  } catch (err) {
    console.error('[에너지등급 API 오류]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════
   ④ Grok AI API
══════════════════════════════════════════ */
app.post('/api/grok', async (req, res) => {
  const { prompt } = req.body;
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROK_API_KEY}`
        },
        timeout: 30000
      }
    );
    res.json(response.data);
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[Grok API 오류]', JSON.stringify(detail));
    res.status(500).json({ error: detail });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ EnergyIQ 서버 실행 중`);
  console.log(`👉 브라우저에서 열기: http://localhost:${PORT}`);
  console.log(`   (종료하려면 Ctrl+C)\n`);
});
