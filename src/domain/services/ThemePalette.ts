import { ThemeRecord } from '../entities';

/**
 * لوحة الألوان — ترجمة `App\Support\ThemeSettings::palette()` و`ColorSitting::DEFAULTS`
 * كي يرث التطبيق نفس ألوان وخطّ النسخة الويب المضبوطة من شاشة «مظهر النظام».
 */
export const THEME_DEFAULTS = {
  color: '#ffffff',
  primary_color: '#7367F0',
  success_color: '#28C76F',
  danger_color: '#EA5455',
  info_color: '#00CFE8',
  warning_color: '#FF9F43',
  font_family: 'Cairo',
  border_radius: '6px',
  layout_mode: 'light',
};

export interface Palette {
  primary: string;
  primaryHover: string;
  primarySoft: string;
  onPrimary: string;
  success: string;
  danger: string;
  info: string;
  warning: string;
  link: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
}

export interface ThemeDTO {
  appTitle: string | null;
  fontFamily: string;
  borderRadius: number;
  layoutMode: 'light' | 'dark' | 'semi-dark';
  logoUrl: string | null;
  faviconUrl: string | null;
  light: Palette;
  dark: Palette;
}

function clamp(n: number) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return [115, 103, 240];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function darken(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = 1 - amount;
  return '#' + [r, g, b].map((c) => clamp(c * f).toString(16).padStart(2, '0')).join('');
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** لون نصّ مقروء فوق هذا اللون — نفس فكرة `ColorTools::readableOn` */
export function readableOn(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#4b4b4b' : '#ffffff';
}

function pick(value: string | null | undefined, fallback: string): string {
  return value && value.trim() !== '' ? value : fallback;
}

export function buildTheme(record: ThemeRecord | null, publicUrl: string): ThemeDTO {
  const primary = pick(record?.primaryColor, THEME_DEFAULTS.primary_color);
  const success = pick(record?.successColor, THEME_DEFAULTS.success_color);
  const danger = pick(record?.dangerColor, THEME_DEFAULTS.danger_color);
  const info = pick(record?.infoColor, THEME_DEFAULTS.info_color);
  const warning = pick(record?.warningColor, THEME_DEFAULTS.warning_color);
  const link = pick(record?.linkColor, primary);
  const bodyBg = pick(record?.color, THEME_DEFAULTS.color);

  const shared = {
    primary,
    primaryHover: darken(primary, 0.1),
    primarySoft: rgba(primary, 0.12),
    onPrimary: readableOn(primary),
    success,
    danger,
    info,
    warning,
    link,
  };

  const layoutMode = (record?.layoutMode as ThemeDTO['layoutMode']) || 'light';
  const radius = parseInt(pick(record?.borderRadius, THEME_DEFAULTS.border_radius), 10);

  return {
    appTitle: record?.appTitle ?? null,
    fontFamily: pick(record?.fontFamily, THEME_DEFAULTS.font_family),
    borderRadius: Number.isNaN(radius) ? 6 : radius,
    layoutMode: ['light', 'dark', 'semi-dark'].includes(layoutMode) ? layoutMode : 'light',
    logoUrl: record?.loginLogo ? `${publicUrl}/storage/${record.loginLogo}` : `${publicUrl}/app-assets/images/logo/logo.png`,
    faviconUrl: record?.favicon ? `${publicUrl}/storage/${record.favicon}` : null,
    light: {
      ...shared,
      background: bodyBg === '#ffffff' ? '#f8f8f8' : bodyBg,
      surface: '#ffffff',
      text: '#4b4b4b',
      muted: '#7b8194',
      border: '#e6e9f0',
    },
    dark: {
      ...shared,
      background: '#161d31',
      surface: '#283046',
      text: '#d0d2d6',
      muted: '#8a8f9c',
      border: '#3b4253',
    },
  };
}
