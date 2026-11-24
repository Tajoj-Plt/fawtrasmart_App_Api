/** خطأ إعدادات البيئة — يحمل أسماء الحقول الناقصة/الخاطئة فقط، لا قيمها */
export class ConfigError extends Error {
  constructor(public readonly details: Record<string, string[] | undefined>) {
    super('Invalid environment configuration: ' + Object.keys(details).join(', '));
    this.name = 'ConfigError';
  }
}
