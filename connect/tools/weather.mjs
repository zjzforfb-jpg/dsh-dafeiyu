/** 天气查询（wttr.in，无需 key；Node 会走 NODE_USE_ENV_PROXY 的代理）。 */
const KNOWN_CITIES = ['石家庄', '北京', '上海', '广州', '深圳', '杭州', '成都', '南京', '武汉', '西安', '天津', '重庆', '苏州', '郑州', '长沙', '济南', '青岛', '沈阳', '大连', '厦门', '福州', '合肥', '昆明', '南昌', '哈尔滨', '太原', '保定'];

export function cityFromText(text, fallback = '石家庄') {
  const found = KNOWN_CITIES.find((city) => String(text ?? '').includes(city));
  return found ?? fallback;
}

export function wantsWeather(text) {
  return /天气|气温|下雨|下雪|冷不冷|热不热|穿什么|多少度/u.test(String(text ?? ''));
}

export async function getWeather(city = '石家庄', { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('weather_unavailable');
  const data = await response.json();
  const current = data?.current_condition?.[0];
  if (!current) throw new Error('weather_empty');
  const desc = current.lang_zh?.[0]?.value ?? current.weatherDesc?.[0]?.value ?? '';
  const temp = current.temp_C;
  const feels = current.FeelsLikeC;
  const humidity = current.humidity;
  const wind = current.windspeedKmph;
  const today = data?.weather?.[0];
  const maxT = today?.maxtempC;
  const minT = today?.mintempC;
  return {
    city,
    text: `${city}现在 ${desc || '天气'}，${temp}°C（体感 ${feels}°C），今天 ${minT}~${maxT}°C，湿度 ${humidity}%，风速 ${wind}km/h。`,
    temp: Number(temp),
    desc,
  };
}
