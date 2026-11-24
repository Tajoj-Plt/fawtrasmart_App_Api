import { Knex } from 'knex';
import { ApplicationStatuses, SubscriptionSnapshot, SystemLanguage, ThemeRecord } from '../../domain/entities';
import { SettingsRepository } from '../../domain/repositories';
import { bool } from '../db/knex';

export class KnexSettingsRepository implements SettingsRepository {
  constructor(private readonly db: Knex) {}

  async applicationStatuses(): Promise<ApplicationStatuses> {
    try {
      const rows = await this.db('application_settings').select('key', 'status');
      const map: ApplicationStatuses = {};
      for (const r of rows) map[String(r.key)] = r.status === 'active' ? 'active' : 'inactive';
      return map;
    } catch {
      // الجدول غير مُهجَّر بعد — كل الوحدات مفعَّلة كما يفترض الويب
      return {};
    }
  }

  async subscription(): Promise<SubscriptionSnapshot> {
    const none: SubscriptionSnapshot = {
      linked: false, isActive: true, isExpired: false, isTrial: false,
      status: null, planName: null, endDate: null, daysRemaining: null, permissions: {},
    };

    try {
      const row = await this.db('fawtra_subscription').first();
      if (!row || !row.snapshot) return none;

      const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
      // `plan.plan.permissions ?? plan.permissions` — كما في FawtraSubscription::plan()
      const plan = snapshot?.plan?.plan ?? snapshot?.plan ?? {};
      const permissions: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(plan?.permissions ?? {})) permissions[k] = Boolean(v);

      return {
        linked: true,
        isActive: bool(row.is_active),
        isExpired: bool(row.is_expired),
        isTrial: bool(row.is_trial),
        status: (row.status as string | null) ?? null,
        planName: (row.plan_name as string | null) ?? plan?.name ?? null,
        endDate: row.end_date ? String(row.end_date).slice(0, 10) : null,
        daysRemaining: row.days_remaining === null || row.days_remaining === undefined ? null : Number(row.days_remaining),
        permissions,
      };
    } catch {
      return none;
    }
  }

  async theme(): Promise<ThemeRecord | null> {
    try {
      const row = await this.db('color_sittings').first();
      if (!row) return null;
      return {
        color: row.color ?? null,
        primaryColor: row.primary_color ?? null,
        successColor: row.success_color ?? null,
        dangerColor: row.danger_color ?? null,
        infoColor: row.info_color ?? null,
        warningColor: row.warning_color ?? null,
        linkColor: row.link_color ?? null,
        fontFamily: row.font_family ?? null,
        layoutMode: row.layout_mode ?? null,
        borderRadius: row.border_radius ?? null,
        appTitle: row.app_title ?? null,
        loginLogo: row.login_logo ?? null,
        favicon: row.favicon ?? null,
      };
    } catch {
      return null;
    }
  }

  async activeLanguages(): Promise<SystemLanguage[]> {
    try {
      const rows = await this.db('system_languages').where('is_active', 1).orderBy('sort_order').orderBy('id');
      return rows.map((r) => ({
        code: String(r.code),
        name: String(r.name),
        nativeName: (r.native_name as string | null) ?? null,
        direction: r.direction === 'rtl' ? 'rtl' : 'ltr',
        isDefault: bool(r.is_default),
        flag: (r.flag as string | null) ?? null,
        dateFormat: String(r.date_format ?? 'Y-m-d'),
        timeFormat: String(r.time_format ?? 'H:i'),
      }));
    } catch {
      return [];
    }
  }
}
