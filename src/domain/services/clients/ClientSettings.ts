/**
 * «إعدادات وحدات العملاء» — نسخة `App\Support\ClientSettings` و`ClientSettingsHelper`.
 *
 * تُحمَّل صفوف `general_client_settings` (وصفّ `client_module_settings`) مرّة لكل طلب،
 * ثم تُقرأ هنا بلا استعلام. غياب الصفّ = القيمة الافتراضية نفسها في الويب
 * (الويب يُنشئ الصفّ بافتراضاته عند أوّل قراءة، وهنا يُكتفى بالافتراض دون إنشاء).
 */

export interface SettingRow {
  key: string;
  isActive: boolean;
  columns: Record<string, unknown>;
  options: Record<string, unknown> | null;
}

export interface ModuleSettingsRow {
  visitsEnabled: boolean;
  itineraryEnabled: boolean;
  locationEnabled: boolean;
  exemptLocationEnabled: boolean;
  notesEnabled: boolean;
}

/** افتراضات `ClientSettings::definitions()` — للمفاتيح التي تقرؤها وحدة العملاء */
const DEFAULT_COLUMNS: Record<string, Record<string, unknown>> = {
  client_defaults_settings: { default_new_client_status_id: null },
  location_group_settings: { location_required: true, group_required: true },
  upload_limits_settings: { max_upload_size_kb: 102400 },
  visit_proximity_settings: { visit_proximity_radius_km: 0.3 },
  route_tracking_settings: { enable_route_tracking: true },
  itinerary_assignment_settings: { itinerary_restrict_to_assigned_clients: false },
  map_settings: { map_hide_duration_hours: 24 },
};

const DEFAULT_OPTIONS: Record<string, Record<string, unknown>> = {
  client_defaults_settings: {
    client_type_scope: 'Both', require_phone: true, require_mobile: false, unique_phone: false,
    require_tax_number: false, require_email: false, default_registration_stage_id: null,
  },
  client_required_fields_settings: {
    require_trade_name: true, require_commercial_registration: true, require_category: true, require_registration_stage: false,
  },
  client_status_change_settings: { require_manager_approval: true },
  upload_limits_settings: { image_quality_percent: 60, image_max_dimension_px: 1280 },
  visit_note_requirement_settings: { required: true },
  finished_visit_client_settings: { hide_after_complete: true, allow_return_same_day: true },
  visit_workspace_sections_settings: {
    show_location_card: true, show_quick_actions_card: true, show_notes_card: true, show_contact_card: true, show_details_card: true,
    show_notes_tab: true, show_competitors_tab: true, show_competitor_capture: true, note_deposit_count: true, note_photo: true,
    note_min_photos: 1, show_docs_tab: true, show_attachments_tab: true, show_signature_section: true,
  },
  create_screen_client_scope_settings: { restrict_to_itinerary: true },
  itinerary_order_settings: { order_strategy: 'manual', max_clients_per_day: null, lock_after_start: false, allow_reorder_by_employee: true },
  client_employee_settings: { allow_multiple: true, max_employees_per_client: null, assignable_departments: [] },
};

/** تحويل PHP `(bool)`: الصفر و"0" والفارغ والمصفوفة الفارغة `false`، وكل ما عداها `true` */
export const phpBool = (v: unknown): boolean => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '' && v !== '0';
  if (Array.isArray(v)) return v.length > 0;
  return true;
};
const truthy = phpBool;

export class ClientSettings {
  private readonly rows = new Map<string, SettingRow>();

  constructor(rows: SettingRow[], readonly module: ModuleSettingsRow) {
    for (const r of rows) this.rows.set(r.key, r);
  }

  /** عمودٌ في صفّ المجموعة — قيمة الصفّ إن وُجد الصفّ، وإلا الافتراض (`$settings->column`) */
  private column(group: string, field: string): unknown {
    const row = this.rows.get(group);
    if (row) return row.columns[field] ?? null;
    return DEFAULT_COLUMNS[group]?.[field] ?? null;
  }

  /** `ClientSettings::option()` — المحفوظ، ثم افتراض التعريف، ثم الافتراض الممرَّر */
  private option(group: string, key: string, fallback: unknown = null): unknown {
    const saved = this.rows.get(group)?.options?.[key];
    if (saved !== null && saved !== undefined) return saved;
    const defs = DEFAULT_OPTIONS[group];
    if (defs && key in defs) return defs[key];
    return fallback;
  }

  private flag(group: string, key: string, fallback = false): boolean {
    return truthy(this.option(group, key, fallback));
  }

  private integer(group: string, key: string, fallback: number | null = null): number | null {
    const v = this.option(group, key, fallback);
    return v === null || v === '' ? null : Math.trunc(Number(v));
  }

  // ─── العملاء ───
  isLocationRequired(): boolean {
    return truthy(this.column('location_group_settings', 'location_required') ?? true);
  }

  isGroupRequired(): boolean {
    return truthy(this.column('location_group_settings', 'group_required') ?? true);
  }

  /** «الحقول الإضافية ← الصورة» — `fieldEnabled('image')` */
  isImageFieldEnabled(): boolean {
    const row = this.rows.get('image');
    return row ? row.isActive : true;
  }

  clientTypeScope(): string {
    return String(this.option('client_defaults_settings', 'client_type_scope', 'Both'));
  }

  requirePhone() { return this.flag('client_defaults_settings', 'require_phone', true); }
  requireMobile() { return this.flag('client_defaults_settings', 'require_mobile'); }
  uniquePhone() { return this.flag('client_defaults_settings', 'unique_phone'); }
  requireTaxNumber() { return this.flag('client_defaults_settings', 'require_tax_number'); }
  requireEmail() { return this.flag('client_defaults_settings', 'require_email'); }
  requireTradeName() { return this.flag('client_required_fields_settings', 'require_trade_name', true); }
  requireCommercialRegistration() { return this.flag('client_required_fields_settings', 'require_commercial_registration', true); }
  requireCategory() { return this.flag('client_required_fields_settings', 'require_category', true); }
  requireRegistrationStage() { return this.flag('client_required_fields_settings', 'require_registration_stage'); }
  statusChangeRequiresApproval() { return this.flag('client_status_change_settings', 'require_manager_approval', true); }

  /** المضبوط في الإعدادات — وإن غاب يختار المستدعي أوّل حالةٍ قابلة للإسناد */
  configuredDefaultStatusId(): number | null {
    const v = this.column('client_defaults_settings', 'default_new_client_status_id');
    return v ? Number(v) : null;
  }

  defaultRegistrationStageId(): number | null {
    const v = this.option('client_defaults_settings', 'default_registration_stage_id');
    return v ? Number(v) : null;
  }

  maxUploadSizeKb(): number {
    const v = this.column('upload_limits_settings', 'max_upload_size_kb');
    return v !== null && v !== undefined ? Number(v) : 102400;
  }

  uploadImageQuality(): number {
    const percent = this.integer('upload_limits_settings', 'image_quality_percent', 60) ?? 60;
    return Math.max(10, Math.min(100, percent)) / 100;
  }

  uploadImageMaxDimension(): number {
    return Math.max(320, this.integer('upload_limits_settings', 'image_max_dimension_px', 1280) ?? 1280);
  }

  clientEmployeeDepartmentIds(): number[] {
    let v = this.option('client_employee_settings', 'assignable_departments', []);
    if (!Array.isArray(v)) v = v === null || v === '' ? [] : [v];
    return (v as unknown[]).map((x) => Math.trunc(Number(x))).filter((x) => Boolean(x));
  }

  // ─── الزيارات ───
  visitProximityRadiusKm(): number {
    const v = this.column('visit_proximity_settings', 'visit_proximity_radius_km');
    return v !== null && v !== undefined ? Number(v) : 0.3;
  }

  /** نطاق القرب لموظفٍ بعينه (`users.visit_proximity_radius_km`) وإلا العامّ */
  visitProximityRadiusKmFor(userRadius: number | null | undefined): number {
    return userRadius !== null && userRadius !== undefined ? Number(userRadius) : this.visitProximityRadiusKm();
  }

  visitNoteRequired() { return this.flag('visit_note_requirement_settings', 'required', true); }
  hideFinishedVisitClients() { return this.flag('finished_visit_client_settings', 'hide_after_complete', true); }

  allowReturnFinishedClientSameDay(): boolean {
    return this.hideFinishedVisitClients() && this.flag('finished_visit_client_settings', 'allow_return_same_day', true);
  }

  visitWorkspaceSectionVisible(key: string): boolean {
    return this.flag('visit_workspace_sections_settings', key, true);
  }

  competitorCaptureEnabled() { return this.visitWorkspaceSectionVisible('show_competitor_capture'); }
  signatureRequired() { return this.visitWorkspaceSectionVisible('show_signature_section'); }

  noteMinPhotos(): number {
    return Math.max(1, this.integer('visit_workspace_sections_settings', 'note_min_photos', 1) ?? 1);
  }

  // ─── خطوط السير ───
  isRouteTrackingEnabled(): boolean {
    return truthy(this.column('route_tracking_settings', 'enable_route_tracking') ?? true);
  }

  restrictItineraryToAssignedClients(): boolean {
    return truthy(this.column('itinerary_assignment_settings', 'itinerary_restrict_to_assigned_clients') ?? false);
  }

  itineraryMaxClientsPerDay(): number | null {
    return this.integer('itinerary_order_settings', 'max_clients_per_day');
  }

  itineraryLockAfterStart() { return this.flag('itinerary_order_settings', 'lock_after_start'); }
}
