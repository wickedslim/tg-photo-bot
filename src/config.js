// Адрес сервера (Cloudflare Worker), например https://tg-photo-bot.<ваше-имя>.workers.dev
// Задаётся при сборке: переменная VITE_API_URL (на GitHub — Settings → Variables → API_URL).
export const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
