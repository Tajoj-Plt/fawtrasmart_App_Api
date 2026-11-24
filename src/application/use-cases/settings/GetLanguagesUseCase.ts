import { SystemLanguage } from '../../../domain/entities';
import { SettingsRepository } from '../../../domain/repositories';
import { Cache } from '../../ports';

/** اللغات الفعّالة من `system_languages` — التطبيق يدعم ar/en حالياً ويعرض ما يتقاطع معها */
export class GetLanguagesUseCase {
  constructor(private readonly settings: SettingsRepository, private readonly cache: Cache, private readonly ttl: number) {}

  async execute(): Promise<SystemLanguage[]> {
    const languages = await this.cache.wrap('settings:languages', this.ttl, () => this.settings.activeLanguages());

    if (languages.length === 0) {
      return [
        { code: 'ar', name: 'Arabic', nativeName: 'العربية', direction: 'rtl', isDefault: true, flag: null, dateFormat: 'Y-m-d', timeFormat: 'H:i' },
        { code: 'en', name: 'English', nativeName: 'English', direction: 'ltr', isDefault: false, flag: null, dateFormat: 'Y-m-d', timeFormat: 'H:i' },
      ];
    }

    return languages;
  }
}
