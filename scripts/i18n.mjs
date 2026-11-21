import english from '../lang/en.json' with {type: 'json'};
export function t(key, data = {}) {
  const i18n = globalThis.game?.i18n;
  const translated = i18n?.localize?.(key);
  const text = typeof translated === 'string' && translated !== key ? translated : english[key] ?? key.split('.').reduce((value, part) => value?.[part], english) ?? key;
  return String(text).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(data, name) ? String(data[name]) : match);
}

export function a(key, data) {
 return t(key, data).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
}

// Module manifests can remain cached by an already-running Foundry server.
// Register bundled English defaults for native Handlebars lookups as well as t().
// Existing translations and translations supplied by language packs always win.
export function installEnglishFallback(i18n = globalThis.game?.i18n) {
 if (!i18n) return;
 i18n._fallback ??= {};
 const read = (obj, parts) => parts.reduce((value, part) => value?.[part], obj);
 const visit = (obj, prefix = []) => {
  for (const [key, value] of Object.entries(obj)) {
   const parts = [...prefix, ...key.split('.')];
   if (value && typeof value === 'object') { visit(value, parts); continue; }
   if (typeof value !== 'string' || typeof read(i18n.translations, parts) === 'string' || typeof read(i18n._fallback, parts) === 'string') continue;
   let target = i18n._fallback;
   for (const part of parts.slice(0, -1)) { if (!target[part] || typeof target[part] !== 'object') target[part] = {}; target = target[part]; }
   target[parts.at(-1)] = value;
  }
 };
 visit(english);
}
globalThis.Hooks?.once?.('i18nInit', () => installEnglishFallback());
globalThis.Hooks?.once?.('ready', () => installEnglishFallback());
